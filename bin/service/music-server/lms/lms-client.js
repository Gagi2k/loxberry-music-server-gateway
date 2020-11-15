'use strict';

var net = require('net');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync("config.json"));
const os = require('os');
const process = require('child_process');

var notificationSocket
var cmdSocket

module.exports = class LMSClient {
    constructor(mac, data_callback) {
        this._mac = mac;
        if (!this._mac)
            this._mac = ""
        this.data_callback = data_callback;

        if (config.lms_host == "localhost" || config.lms_host == "127.0.0.1")
            this._host = config.ip ? config.ip : os.hostname();
        else
            this._host = config.lms_host;
        this._hostUrl = "http://" + this._host + ":" + config.lms_port;

        if (!notificationSocket) {
            const options = { host: this._host, port: config.lms_cli_port };
            const connection_listener = () => {
                notificationSocket.write('listen 1 \r\n');
            }
            notificationSocket = net.createConnection(options, connection_listener);
            notificationSocket.setMaxListeners(200);
            notificationSocket.on('end', () => {
                               console.debug('disconnected from server');
                           });
            notificationSocket.on('timeout', () => {
                               console.debug('Socket timeout, closing');
                               notificationSocket.close();
                           });
            notificationSocket.on('error', (err) => {
                               console.debug('Socket error: ' + err.message);
                           });
            notificationSocket.on('close', (err) => {
                               console.debug('Socket closed. Reconnecting...');
                               setTimeout(() => { notificationSocket.connect(options, connection_listener) }, 1000);
                           });
        }

        if (this.data_callback) {

            notificationSocket.on('data', (data) => {
                                      var splitted = data.toString().split('\n')

                                      for (var i in splitted) {
                                          var dataStr = splitted[i];

                                          // check whether the notification is for us
                                          let encoded_mac = this._mac.replace(/:/g, "%3A");
                                          if (!dataStr.startsWith(encoded_mac))
                                              return

                                          // Remove the zone id from the notification
                                          dataStr = dataStr.slice(encoded_mac.length).trim();

                                          this.data_callback(dataStr);
                                      }
                                  });
        }

        if (!cmdSocket) {
            const options = { host: this._host, port: config.lms_cli_port };
            const connection_listener = () => {
                console.debug('connected to server!');
            }
            cmdSocket = net.createConnection(options, connection_listener);
            cmdSocket.setMaxListeners(200);
            cmdSocket.on('end', () => {
                               console.debug('disconnected from server');
                           });
            cmdSocket.on('timeout', () => {
                               console.debug('Socket timeout, closing');
                               cmdSocket.close();
                           });
            cmdSocket.on('error', (err) => {
                               console.debug('Socket error: ' + err.message);
                           });
            cmdSocket.on('close', (err) => {
                               console.debug('Socket closed. Reconnecting...');
                               setTimeout(() => { cmdSocket.connect(options, connection_listener) }, 3000);
                           });
        }

    }

    async command(cmd) {
        var returnValue = cmd;
        if (this._mac)
            returnValue = this._mac + " " + returnValue
        if (returnValue.endsWith("?"))
            returnValue = returnValue.slice(0, -2);

        returnValue = returnValue.replace(/:/g, "%3A")
        returnValue = returnValue.replace(/\//g, "%2F")

        return new Promise((resolve, reject) => {
                               let response = "";
                               var responseListener = (data) => {
//                                   console.log("DATA ", data.toString())
                                   response += data;
                                   if (!response.toString().endsWith('\n')) {
//                                       console.log("WAITING FOR MORE")
                                       return;
                                   }
//                                   console.log("RESPONSE ", response.toString())

                                   var splitted = response.toString().split('\n')
//                                   console.log("RESPONSE", splitted, returnValue)
                                   for (var i in splitted) {
                                       var processed = splitted[i];
                                       if (processed.startsWith(returnValue)) {
//                                           console.log("RESPONSE FOR: ", returnValue)
//                                           console.log("RESPONSE: ", data.toString())
                                           // Once we have the response we wait for return
                                           cmdSocket.removeListener('data', responseListener);
                                           processed = processed.replace(returnValue, "")
                                           processed = processed.replace("\r", '')
                                           processed = processed.replace("\n", '')
                                           processed = processed.trim()
                                           resolve(processed);
                                       }
                                   }
                               };

                               cmdSocket.on('data', responseListener);
//                               console.log("REQUEST: ", this._mac + " " + cmd)
                               cmdSocket.write(this._mac + " " + cmd + ' \r\n');
                           });
    }


    parseAdvancedQueryResponse(data, object_split_key, filteredKeys, count_key = 'count') {
        // Remove leading/trailing white spaces
        let count = 0
        let response = data.trim();
        let strings = response.split(' ')
        let current_item = {}
        let items = []
        for (let i in strings) {
            var str = strings[i];
            var colon = '%3A';
            var index = str.indexOf(colon)
            var key = str.slice(0, index);
            var value = str.slice(index + colon.length);
//            console.log("STR ", str, index, key, value)

            if (key == count_key) {
                count = parseInt(value);
                continue
            }

            if (Array.isArray(filteredKeys)) {
                if (filteredKeys.includes(key))
                    continue
            }

            if (object_split_key) {
                if (key == object_split_key) {
                    if (Object.keys(current_item).length !== 0)
                        items.push(current_item);
                    current_item = {};
                }
            }
            current_item[key] = value;
        }
        if (Object.keys(current_item).length !== 0)
            items.push(current_item);
//        console.log("ITEMS ", JSON.stringify(items))
        return {
            count: count,
            items: items
        };
    }

    parseAdvancedQueryResponse2(data, requiredKeys, count_key = 'count') {
        // Remove leading/trailing white spaces
        let count = 0
        let response = data.trim();
        let strings = response.split(' ')
        let current_item = {}
        let items = []
        for (let i in strings) {
            var str = strings[i];
            var colon = '%3A';
            var index = str.indexOf(colon)
            var key = str.slice(0, index);
            var value = str.slice(index + colon.length);

            if (key == count_key) {
                count = parseInt(value);
                continue
            }
            current_item[key] = value;

            const keys = Object.keys(current_item);
            if (requiredKeys.every(val => keys.includes(val))) {
                items.push(current_item);
                current_item = {};
            }
        }
        if (Object.keys(current_item).length !== 0)
            items.push(current_item);

        return {
            count: count,
            items: items
        };
    }

    async artworkFromTrackId(id) {
        if (!id)
            return undefined;
        let response = await this.command('songinfo 0 100 track_id:' + id)
        let item = this.parseAdvancedQueryResponse(response).items[0];

        return this.extractArtwork("", item);
    }

    async artworkFromUrl(url) {
        if (!url)
            return undefined;
        let response = await this.command('songinfo 0 100 url:' + url)
        let item = this.parseAdvancedQueryResponse(response).items[0];

        return this.extractArtwork(url, item);
    }

    extractArtwork(url, item) {
        if ('artwork_track_id' in item) {
            return this._hostUrl + "/music/" + item['artwork_track_id'] + "/cover"
        }

        if ('image' in item) {
            return this.resolveUrl(unescape(item['image']));
        }

        if ('icon' in item) {
            return this.resolveUrl(unescape(item['icon']));
        }

        if ('artwork_url' in item) {
            let artwork_url = unescape(item['artwork_url']);

            // Before accepting this default icon, try to be smart and parse the ID of the station
            // and resolve the icon ourself
            if (artwork_url == "plugins/TuneIn/html/images/icon.png") {
                var regex = /id%3Ds(\d+)%26/
                var match = regex.exec(url);
                if (match && match[1]) {
                    return 'http://cdn-radiotime-logos.tunein.com/s' + match[1] + 'q.png/image.png'
                }
            }

            return this.resolveUrl(artwork_url);
        }

        return undefined
    }

    resolveUrl(str) {
        str = unescape(str);

        // The imageproxy urls are correct, but the app unescapes the URL before using it
        // This doesn't work as the escaping is needed to make the parameters work
        // We double escape it here as workaround
        if (str.startsWith("/imageproxy"))
            str = str.replace(/\?t=.*\//g, "/");

        if (str.startsWith("http"))
            return str;

        if (!str.startsWith("/"))
            str = "/" + str

        return this._hostUrl + str;
    }

    parseId(str) {
        if (!str.includes(":"))
            return {type: "", id: str }
        let s = str.toString().split(":")
        return {type:s[0], id:s[1]};
    }

    execute_script(name, args) {
        var script = config.scripts ? config.scripts[name] : undefined
        if (!script) {
            console.error(`no script configured for: ${name}`);
            return
        }

        script = script.replace('{{name}}', name);
        for (var key in args)
            script = script.replace('{{' + key + '}}', args[key]);

        process.exec(script, (err, stdout, stderr) => {
            if (err) {
                //some err occurred
                console.error(`failed to execute ${script}: ${err}`);
            } else {
               // the *entire* stdout and stderr (buffered)
               console.log(`script ${name} stdout: ${stdout}`);
               console.log(`script ${name} stderr: ${stderr}`);
            }
        })
    }
}
