"use strict";

var os = require('os');
var spawn = require('child_process').spawn;
var net = require('net');
var schedule = require('node-schedule');

var quipu = require('quipu');
var sensor = require('6sense');
var sixSenseCodec = require('6sense/src/codec/encodeForSMS.js')
var genericCodec = require('quipu/parser.js');

var PRIVATE = require('../PRIVATE.json');


// === to set ===
var devices = {
    modem: '/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if00-port0',
    sms: '/dev/serial/by-id/usb-HUAWEI_HUAWEI_HiLink-if02-port0'
};

var MEASURE_PERIOD = 10; // in seconds
var WAKEUP_HOUR_UTC = '07';
var SLEEP_HOUR_UTC = '16';
// ===

var signal = 'NODATA';
var tcpSocket = undefined;
var DEBUG = process.env.DEBUG ? process.env.DEBUG : false;

var messageQueue = [];

var debug = function() {
    if (DEBUG) {
        [].unshift.call(arguments, '[DEBUG 6brain] ');
        console.log.apply(console, arguments);
    };
}

// Transform a networkType (as returned by AT^SYSINFO) in a sendable data
function getSendableSignal(signal) {
    if (signal === undefined || signal < 2)
        return 'NODATA';    // No internet
    if (signal === 2)
        return 'GPRS';  // GPRS
    if (signal === 3)
        return 'EDGE';  // EDGE
    if (signal === 4)
        return '3G';    // 3G
    if (signal > 4)
        return 'H/H+';  // 3G+ or better
    return 'unknown';
}


// TCP BLOCK
function tcpConnect() {

    var socket = net.connect(PRIVATE.connectInfo);

    socket.on('connect', function(){
        console.log('connected to the server');
        tcpSocket = socket;
        sendTCP("phoneNumber=" + PRIVATE.connectInfo.phoneNumber)
    });

    var chunk = "";
    var d_index;
    socket.on('data', function(data) {
        // accumulate tcp stream until \n meaning new chunk
        chunk += data.toString();
        d_index = chunk.indexOf('\n');

        while (d_index > -1) {
            var message = chunk.substring(0, d_index); // Create string up until the delimiter
            console.log("data received : " + message);
            if (message.slice(0, 4) === 'cmd:') {
                var cmdArgs = message.toLowerCase().slice(4).split(' ');
                commandHandler(cmdArgs, send);
            }
            chunk = chunk.substring(d_index + 1); // Cuts off the processed chunk
            d_index = chunk.indexOf('\n'); // Find the new delimiter
        }

    });

    socket.on('close', function() {
        console.log("tcp disconnected");
        setTimeout(tcpConnect, 10000); // Be warning : recursive
    });

    socket.on('error', function(err){
        console.log("tcp error", err);
    });
}

// QUIPU BLOCK
spawn('killall', ["pppd"]);
quipu.handle('initialize', devices, PRIVATE.PIN);

quipu.on('transition', function (data) {
    console.log('Transitioned from ' + data.fromState + ' to ' + data.toState);


    if (data.fromState === 'uninitialized' && data.toState === 'initialized') {

        console.log('quipu initialized');
        console.log('opening 3G');
        quipu.handle('open3G');
        quipu.askNetworkType();

    }

    if (data.toState === '3G_connected') {
        if (data.fromState === 'initialized') {
            console.log('3G initialized');
            tcpConnect();

            // check the connectivity state
            setInterval(function(){
                quipu.askNetworkType();
                var tmp = getSendableSignal(quipu.getNetworkType());
                if (tmp != signal) {
                    signal = tmp;
                    sendTCP('net'+signal, 'clear'); // Not send because it doesn't start with 0
                }
            }, 5000);
        }

    }

    if (data.fromState === '3G_connected' && data.toState === 'tunnelling') {
        send('opentunnel:OK', "generic_encoded");
    }

});

quipu.on('3G_error', function() {
    console.log('exiting');
    process.exit(-1);
});

quipu.on('tunnelError', function() {
    console.log('tunnel error');
    send('opentunnel:KO', "generic_encoded");
});

quipu.on('smsReceived', function(sms) {
    console.log('SMS received : \"' + sms.body + '\" ' + 'from \"' + sms.from + '\"');
    if (sms.body.toString().slice(0, 4) === 'cmd:' && authorizedNumbers.indexOf(sms.from) > -1) {
        var cmdArgs = sms.body.toString().toLowerCase().slice(4).split(' ');
        commandHandler(cmdArgs, send);
    }
});


// 6SENSE BLOCK

sensor.on('processed', function(results) {
    sixSenseCodec([results]).then(function(message){
        sendTCP('1' + message);
    });
});

sensor.on('transition', function (data){
    send('null:null', 'generic_encoded');
});

var restart6senseIfNeeded = function(returnMessage, encoding){
    sensor.pause();
    setTimeout(function(){
        var date = new Date();
        var current_hour = date.getHours();
        if (current_hour < parseInt(SLEEP_HOUR_UTC) && current_hour >= parseInt(WAKEUP_HOUR_UTC)){
            sensor.record(MEASURE_PERIOD);
        }
        send(returnMessage, encoding);
    }, 3000);
}

// stop measurments at SLEEP_HOUR_UTC
var stopJob = schedule.scheduleJob('00 '+ SLEEP_HOUR_UTC + ' * * *', function(){
    console.log('Pausing measurments.');
    sensor.pause();
});

// restart measurments at WAKEUP_HOUR_UTC
var startJob = schedule.scheduleJob('00 ' + WAKEUP_HOUR_UTC + ' * * *', function(){
    console.log('Restarting measurments.');
    sensor.record(MEASURE_PERIOD);
});

// Empty the unsent message queue

setInterval(function() {
    if (messageQueue.length > 0)
        debug('sending the content of the errored messages, size :', messageQueue.length);
    while (messageQueue.length > 0) {
        var msg = messageQueue.shift();
        sendTCP(msg);
    }
}, 60 * 1000);

// SEND MESSAGE BLOCK

function sendTCP(message) {
    if (tcpSocket) {
        tcpSocket.write(message + "\n", function(err) {
            if (err) {
                messageQueue.push(message);
            }
        });
    }
    else
        console.log("tcpSocket not ready for message, ", message);
}

// Encode and send data
function send(message, encode) {
    if (encode === 'generic_encoded') {
        var body = {
        info:
            {command: message.split(':')[0], result: message.split(':')[1]},
        quipu: {
            state: quipu.state,
        },
        sense: sensor.state
        };
        genericCodec.encode(body)
        .then(function(newMessage){
            sendTCP('2' + newMessage);
        })
    }
    else {
        sendTCP('0' + message);
    }
}



// COMMAND BLOCK

function commandHandler(commandArgs, sendFunction) { // If a status is sent, his pattern is [command]:[status]

    var command = (commandArgs.length >= 1) ? commandArgs[0] : undefined;
    debug('command received : ' + command + '. callback : ' + sendFunction.name);
    debug("args :", commandArgs);

    switch(commandArgs.length) {

        case 1:
            // command with no parameter
            switch(command) {
                case 'status':               // Send the quipu and 6sense sensor
                    sendFunction(command + ':OK', 'generic_encoded')
                    break;
                case 'reboot':               // Reboot the system
                    spawn('reboot');
                    break;
                case 'resumerecord':         // Start recording
                    sensor.record(MEASURE_PERIOD);
                    sendFunction(command + ':OK', 'generic_encoded');
                    break;
                case 'pauserecord':          // Pause recording
                    sensor.pause();
                    sendFunction(command + ':OK', 'generic_encoded');
                    break;
                case 'closetunnel':          // Close the SSH tunnel
                    quipu.handle('closeTunnel');
                    sendFunction(command + ':OK', 'generic_encoded');
                    break;
            }
            break;

        case 2:
            // command with one parameters
            switch(command) {
                case 'changeperiod':
                    if (commandArgs[1].toString().match(/^\d{1,5}$/)) {
                        MEASURE_PERIOD = parseInt(commandArgs[1], 10);
                        restart6senseIfNeeded(command + ':' + commandArgs[1], 'generic_encoded');
                    } else {
                        console.log('Period is not an integer ', commandArgs[1]);
                        sendFunction(command + ':KO', 'generic_encoded');
                    }
                    break;
                case 'changestarttime':      // Change the hour when it starts recording
                    if (commandArgs[1].match(/^\d{1,2}$/)) {
                        WAKEUP_HOUR_UTC = commandArgs[1];
                        restart6senseIfNeeded(command + ':' + commandArgs[1], 'generic_encoded');

                        startJob.cancel();
                        startJob = schedule.scheduleJob('00 ' + WAKEUP_HOUR_UTC + ' * * *', function(){
                            console.log('Restarting measurments.');
                            sensor.record(MEASURE_PERIOD);
                        });
                    }
                    else
                        sendFunction(command + ':KO', 'generic_encoded');
                    break;
                case 'changestoptime':       // Change the hour when it stops recording
                    if (commandArgs[1].match(/^\d{1,2}$/)) {
                        SLEEP_HOUR_UTC = commandArgs[1];
                        restart6senseIfNeeded(command + ':' + commandArgs[1], 'generic_encoded');

                        stopJob.cancel();
                        stopJob = schedule.scheduleJob('00 '+ SLEEP_HOUR_UTC + ' * * *', function(){
                            console.log('Pausing measurments.');
                            sensor.pause();
                        });
                    }
                    else
                        sendFunction(command + ':KO', 'generic_encoded');
                    break;
                case 'date':                 // Change the sensor's date
                        var date = commandArgs[1].replace('t', ' ').split('.')[0];
                        spawn('timedatectl', ['set-time', date]);
                        restart6senseIfNeeded(command + ':' + commandArgs[1], 'generic_encoded');
                    break;
            }
            break;

        case 4:
            // command with three parameters
            switch(command) {
                case 'opentunnel':           // Open a reverse SSH tunnel
                    debug("sending tunnel command");
                    quipu.handle('openTunnel', commandArgs[1], commandArgs[2], commandArgs[3])
                    break;
            }
            break;

        case 5:
            // command with three parameters
            switch(command) {
                case 'init':                 // Initialize period, start and stop time
                    debug("received init command");
                    if (commandArgs[1].toString().match(/^\d{1,5}$/) && commandArgs[2].match(/^\d{1,2}$/) && commandArgs[3].match(/^\d{1,2}$/)) {
                        var date = commandArgs[4].replace('t', ' ').split('.')[0];
                        spawn('timedatectl', ['set-time', date]);
                        MEASURE_PERIOD = parseInt(commandArgs[1], 10);
                        WAKEUP_HOUR_UTC = commandArgs[2];
                        SLEEP_HOUR_UTC = commandArgs[3];
                        restart6senseIfNeeded(command + ':OK', 'generic_encoded');
                    }
                    break;
            }
            break;

        default:
            console.log('Unrecognized command.', commandArgs)
            break;
    }
}