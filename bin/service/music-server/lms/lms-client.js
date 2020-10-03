'use strict';

var net = require('net');

module.exports = class LMSClient {
    constructor(mac, data_callback) {
        this._mac = mac;
        if (!this._mac)
            this._mac = ""
        this.data_callback = data_callback;

        if (this.data_callback) {
            this.notifications = net.createConnection({ host: "192.168.1.6", port: 9090 }, () => {
                                                   console.debug('notifications!');
                                                   this.notifications.write('listen 1 \r\n');
                                               });
            this.notifications.on('data', (data) => {
                                      var dataStr = data.toString();
                                      // console.log("<<<<<<<<<<<<<<<<<<<<", dataStrs);
                                      // check whether the notification is for us
                                      // TODO only when used with id
                                      //      we need a different way for global things like favorites
                                      if (!dataStr.startsWith(this._mac))
                                          return

                                      // Remove the zone id from the notification
                                      dataStr = dataStr.slice(this._mac.length + 1);

                                      this.data_callback(dataStr);
                                  });
        }

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
        var returnValue = cmd;
        if (this._mac)
            returnValue = this._mac + " " + returnValue
        if (returnValue.endsWith("?"))
            returnValue = returnValue.slice(0, -2);

        return new Promise((resolve, reject) => {
                               var responseListener = (data) => {
                                   var processed = data.toString()
//                                   console.log("RESPONSE", processed)
                                   if (processed.startsWith(returnValue)) {
//                                       console.log("RESPONSE FOR: ", returnValue)
//                                       console.log("RESPONSE: ", data.toString())
                                       // Once we have the response we wait for return
                                       this.telnet.removeListener('data', responseListener);
                                       processed = processed.replace(returnValue, "")
                                       processed = processed.replace("\r", '')
                                       processed = processed.replace("\n", '')
                                       processed = processed.trim()
                                       resolve(processed);
                                   }
                               };

                               this.telnet.on('data', responseListener);
//                               console.log("REQUEST: ", this._mac + " " + cmd)
                               this.telnet.write(this._mac + " " + cmd + ' \r\n');
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

    async artworkFromTrackId(id) {
        if (!id)
            return undefined;
        let response = await this.command('songinfo 0 100 track_id%3A' + id)
        let item = this.parseAdvancedQueryResponse(response).items[0];

        return this.extractArtwork("", item);
    }

    async artworkFromUrl(url) {
        if (!url)
            return undefined;
        let response = await this.command('songinfo 0 100 url%3A' + url)
        let item = this.parseAdvancedQueryResponse(response).items[0];

        return this.extractArtwork(url, item);
    }

    extractArtwork(url, item) {
        if ('artwork_track_id' in item) {
            return "http://192.168.1.6:9000/music/" + item['artwork_track_id'] + "/cover"
        }

        if ('artwork_url' in item) {
            let artwork_url = unescape(item['artwork_url']);
            if (artwork_url.startsWith("http"))
                return artwork_url;

            // Before accepting this default icon, try to be smart and parse the ID of the station
            // and resolve the icon ourself
            if (artwork_url == "plugins/TuneIn/html/images/icon.png") {
                var regex = /id%3Ds(\d+)%26/
                var match = regex.exec(url);
                if (match && match[1]) {
                    return 'http://192.168.1.6:9000/imageproxy/http%3A%2F%2Fcdn-radiotime-logos.tunein.com%2Fs' + match[1] + 'q.png/image.png'
                }
            }

            if (!artwork_url.startsWith("/"))
                artwork_url = "/" + artwork_url

            return "http://192.168.1.6:9000" + artwork_url;
        }

        return undefined
    }

    parseId(str) {
        if (!str.includes(":"))
            return {type: "", id: str }
        let s = str.toString().split(":")
        return {type:s[0], id:s[1]};
    }
}
