'use strict';

var net = require('net');

module.exports = class LMSClient {
    constructor(id, data_callback) {
        this._id = id;
        this.data_callback = data_callback;

        this.notifications = net.createConnection({ host: "192.168.1.6", port: 9090 }, () => {
                                               console.debug('notifications!');
                                               this.notifications.write('listen 1 \r\n');
                                           });
        this.notifications.on('data', (data) => {
                                  var dataStr = data.toString();
                                  console.log("<<<<<<<<<<<<<<<<<<<<", dataStr);
                                  // check whether the notification is for us
                                  // TODO only when used with id
                                  //      we need a different way for global things like favorites
                                  if (!dataStr.startsWith(this._id))
                                      return

                                  // Remove the zone id from the notification
                                  dataStr = dataStr.slice(this._id.length + 1);

                                  this.data_callback(dataStr);
                              });

        this.telnet = net.createConnection({ host: "192.168.1.6", port: 9090 }, () => {
                                               console.debug('doTelnet connected to server!');
                                           });
        this.telnet.on('end', () => {
                           console.debug('doTelnet disconnected from server');
                       });
        this.telnet.on('timeout', () => {
                           console.debug('doTelnet Socket timeout, closing');
                           this.telnet.close();
                       });
        this.telnet.on('error', (err) => {
                           console.debug('doTelnet Socket error: ' + err.message);
                       });
        this.telnet.on('close', (err) => {
                           console.debug('doTelnet Socket closed');
                       });

    }

    async command(cmd) {
        var returnValue = this._id + " " + cmd;
        if (cmd.endsWith("?")) {
            returnValue = this._id + " " + cmd.slice(0, -1);
        }

        return new Promise((resolve, reject) => {
                               var responseListener = (data) => {
                                   var processed = data.toString()
                                   if (processed.startsWith(returnValue)) {
                                       console.log("RESPONSE FOR: ", returnValue)
                                       console.log("RESPONSE: ", data.toString())
                                       // Once we have the response we wait for return
                                       this.telnet.removeListener('data', responseListener);
                                       processed = processed.replace(returnValue, "")
                                       processed = processed.replace("\r", '')
                                       processed = processed.replace("\n", '')
                                       resolve(processed);
                                   }
                               };

                               this.telnet.on('data', responseListener);
                               console.log("REQUEST: ", this._id + " " + cmd)
                               this.telnet.write(this._id + " " + cmd + ' \r\n');
                           });
    }
}
