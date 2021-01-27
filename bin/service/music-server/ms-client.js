'use strict';

const os = require('os');
const fs = require('fs');
const Log = require("./log");
const console = new Log;

// Lets require and assign LxCommunicator if the global LxCommunicator object doesn't exist yet (Node.js) if (typeof LxCommunicator === 'undefined') { global.LxCommunicator = require('LxCommunicator');
if (typeof LxCommunicator === 'undefined') {
    global.LxCommunicator = require('lxcommunicator');
}

function getUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random()*16|0, v = c === 'x' ? r : (r&0x3|0x8);
        return v.toString(16);
    });
}

var lc;

module.exports = class MSClient {
    constructor(parent) {

        // Prepare our variables
        // uuid is used to identify a device
        this.uuid = getUUID()
        this._lc = parent.loggingCategory().extend("MS");
        lc = this._lc;

        this._cacheFile = ".LoxAPP3.json";
        this._appConfig = {};
        if (fs.existsSync(this._cacheFile)) {
            this._appConfig = JSON.parse(fs.readFileSync(this._cacheFile));
        }

        // Get the LxCommunicator.WebSocketConfig constructor, to save some space
        var WebSocketConfig = LxCommunicator.WebSocketConfig;

        // Instantiate a config object to pass it to the LxCommunicator.WebSocket later
        var config = new WebSocketConfig(WebSocketConfig.protocol.WS,
                                         getUUID(),
                                         os.hostname(),
                                         WebSocketConfig.permission.APP,
                                         false);

        // OPTIONAL: assign the delegateObj to be able to react on delegate calls
        config.delegate = this

        // This is a copy of the old handler, but we resolve responses without code instead of rejecting them
        // This is needed to get responses like the usersettings
        LxCommunicator.WebSocket.prototype._handleResponseByCode = function _handleResponseByCode(response) {
            var code = getLxResponseCode(response);
            if (code >= 200 && code < 300) {            // ok
                this._currentRequest.resolve(response);
            } else if (code >= 300 && code < 400) {     // redirects
                this._currentRequest.reject(response);
            } else if (code >= 400 && code < 500) {     // client errors

                // usually this is being checked for inside the handleBadAuthResponse handler. But since on some devices, the
                // promises reject handler is called after the socket has already been closed - it is needed to be handled here.
                if (code === 401 && this._isAuthenticating()) {
                    // a 401 while authenticating either means the password or the token are invalid.
                    this._invalidToken = this._isAuthenticating(true);
                    this._wrongPassword = !this._invalidToken; // if it's not due to an invalid token, it has to be due to a invalid pass!

                    if (this._invalidToken) {
                        console.error(lc, this.name + "401 returned during token based authentication");
                    } else if (this._wrongPassword) {
                        console.error(lc, this.name + "401 returned during password based authentication");
                    } else {
                        console.error(lc, this.name + "401 returned during authentication - nothing set.");
                    }
                }

                this._currentRequest.reject(response);
            } else if (code >= 500 && code < 600) {     // server errors
                this._currentRequest.reject(response);
            } else if (code >= 600 && code < 1000) {    // proprietary errors
                this._currentRequest.reject(response);
            } else {
                this._currentRequest.resolve(response);
            }
        };

        // Instantiate the LxCommunicator.WebSocket, it is our actual WebSocket
        this._socket = new LxCommunicator.WebSocket(config);
        // As workaround save the callbacks directly in the socket.
        this._socket._callbacks = {};
    }

    socketOnDataProgress(socket, progress) {
        console.log(lc, progress);
    }
    socketOnTokenConfirmed(socket, response) {
        console.log(lc, response);
    }
    socketOnTokenReceived(socket, result) {
        console.log(lc, result);
    }
    socketOnTokenRefresh(socket, newTkObj) {
        console.log(lc, newTkObj);
    }
    socketOnConnectionClosed(socket, code) {
        console.log(lc, code);
    }

    socketOnEventReceived(socket, events, type) {
        events.forEach(function(event) {
            var callback = socket._callbacks[event.uuid];
            if (callback) {
                console.log(lc, "Calling callback for event:", event);
                callback(event);
            }
        });
    }

    isSocketOpen() {
        return this._socket._ws && !this._socket._ws.socketClosed
    }

    appConfig() {
        return this._appConfig;
    }

    user() {
        return this._user;
    }

    async connect(server, user, pw) {
        this._user = user;

        console.log(this._lc, "Connecting to " + server);

        await this._socket.open(server, user, pw);

        console.log(this._lc, "Connected");

        //Check whether we need a new app json
        var lastModified = await this.command("jdev/sps/LoxAPPversion3");

        if (this._appConfig.lastModified != lastModified.LL.value) {
            console.log(this._lc, "Downloading new LoxAPP3.json")

            var response = await this.command("data/LoxAPP3.json");
            fs.writeFileSync(this._cacheFile, response);
            this._appConfig = JSON.parse(response);
        }
    }

    async command(cmd) {
        console.log(this._lc, "REQUEST: " + cmd);
        return this._socket.send(cmd);
    }

    onChanged(uuid, callback) {
        this._socket._callbacks[uuid] = callback;
    }
}
