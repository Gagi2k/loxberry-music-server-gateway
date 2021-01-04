'use strict';

var net = require('net');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync("config.json"));
const os = require('os');
const process = require('child_process');
const http = require('http')

const Log = require("../log");
const console = new Log;

var notificationSocket
var cmdSocket

module.exports = class LMSClient {
    constructor(mac, parent, data_callback) {
        this._mac = mac;
        this._lc = parent.loggingCategory().extend("LMS");
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
                               console.log(this._lc, 'disconnected from server');
                           });
            notificationSocket.on('timeout', () => {
                               console.log(this._lc, 'Socket timeout, closing');
                               notificationSocket.close();
                           });
            notificationSocket.on('error', (err) => {
                               console.log(this._lc, 'Socket error: ' + err.message);
                           });
            notificationSocket.on('close', (err) => {
                               console.log(this._lc, 'Socket closed. Reconnecting...');
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
                console.log(this._lc, 'connected to server!');
            }
            cmdSocket = net.createConnection(options, connection_listener);
            cmdSocket.setMaxListeners(200);
            cmdSocket.on('end', () => {
                               console.log(this._lc, 'disconnected from server');
                           });
            cmdSocket.on('timeout', () => {
                               console.log(this._lc, 'Socket timeout, closing');
                               cmdSocket.close();
                           });
            cmdSocket.on('error', (err) => {
                               console.log(this._lc, 'Socket error: ' + err.message);
                           });
            cmdSocket.on('close', (err) => {
                               console.log(this._lc, 'Socket closed. Reconnecting...');
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
//                                   console.log(this._lc, "DATA ", data.toString())
                                   response += data;
                                   if (!response.toString().endsWith('\n')) {
//                                       console.log(this._lc, "WAITING FOR MORE")
                                       return;
                                   }
//                                   console.log(this._lc, "RESPONSE ", response.toString())

                                   var splitted = response.toString().split('\n')
//                                   console.log(this._lc, "RESPONSE", splitted, returnValue)
                                   for (var i in splitted) {
                                       var processed = splitted[i];
                                       if (processed.startsWith(returnValue)) {
                                           console.log(this._lc, "RESPONSE FOR: ", returnValue)
                                           console.log(this._lc, "RESPONSE: ", data.toString())

                                           // If the response contains also the ? at the end
                                           // it is invalid
                                           if (processed.endsWith("%3F"))
                                               resolve(undefined);

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
                               console.log(this._lc, "REQUEST: ", this._mac + " " + cmd)
                               cmdSocket.write(this._mac + " " + cmd + ' \r\n');
                           });
    }


    async jsonRPCCommand(cmd) {
        return new Promise((resolve, reject) => {
               const postData = JSON.stringify({"method": "slim.request", "params": [this._mac, cmd.split(' ')]});
               console.log(this._lc, "JSON REQUEST: ", postData)
               const options = {
                 hostname: this._host,
                 port: 9000,
                 path: '/jsonrpc.js',
                 method: 'POST',
                 insecureHTTPParser: true,
                 headers: {
                   'Content-Type': 'application/json',
                   'Content-Length': Buffer.byteLength(postData)
                 }
               }
            const req = http.request(options, res => {
              res.on('data', d => {
                console.log(this._lc, "RESPONSE", d.toString())
                resolve(JSON.parse(d).result);
              })
            }).on("error", (err) => {
                      console.log(this._lc, "Error: ", err.message);
                  });
            req.write(postData);
            req.end();
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
//            console.log(this._lc, "STR ", str, index, key, value)

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
//        console.log(this._lc, "ITEMS ", JSON.stringify(items))
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

        if ('artwork_url' in item && item['artwork_url'] != 0) {
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

        if ('coverid' in item && item['coverid']) {
            return this._hostUrl + "/music/" + item['coverid'] + "/cover"
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

    toStorableUrl(url) {
        if (url && url.startsWith(this._hostUrl))
            return url.replace(this._hostUrl, "");
        return url;
    }

    parseId(str) {
        if (!str.includes(":"))
            return {type: "", id: str }
        let [type, ...id] = str.toString().split(":")
        id = id.join(":");
        return {type, id};
    }

    async execute_script(name, args) {
        var script = config.scripts ? config.scripts[name] : undefined
        if (!script) {
            console.error(this._lc, `no script configured for: ${name}`);
            return
        }

        script = script.replace('{{name}}', name);
        for (var key in args)
            script = script.replace('{{' + key + '}}', args[key]);

        return new Promise((resolve, reject) => {
            process.exec(script, (err, stdout, stderr) => {
                if (err) {
                    //some err occurred
                    console.error(this._lc, `failed to execute ${script}: ${err}`);
                    reject();
                } else {
                   // the *entire* stdout and stderr (buffered)
                   console.log(this._lc, `script ${name} stdout: ${stdout}`);
                   console.log(this._lc, `script ${name} stderr: ${stderr}`);
                   resolve(stdout);
                }
            })
        });
    }

    async resolveAudioUrl(id) {
        let parsed_id = this.parseId(id);

        if (parsed_id.type == "fav") {
            let response = await this.command('favorites items 0 1 want_url:1 item_id:' + parsed_id.id);
            let data = this.parseAdvancedQueryResponse(response, 'id');
            return data.items[0].url;
        } else if (parsed_id.type == "url"){
            return parsed_id.id;
        } else if (parsed_id.type.startsWith("service")){
            const [, cmd] = parsed_id.type.split("/");
            let response = await this.command(cmd + ' items 0 1 want_url:1 item_id:' + parsed_id.id);
            let data = this.parseAdvancedQueryResponse(response, 'id');
            if (data.count == 0 || !data.items[0].url) { //Try with a modified id (e.g. for spotty this is needed)
                let splitted = parsed_id.id.split(".")
                let new_id = splitted.slice(0, -1).join("."); //The id without the last index
                let index = splitted.slice(-1); //only the last index

                //use JSON RPC here to retrieve the URL
                response = await this.jsonRPCCommand(cmd + ' items ' + index + ' 1 want_url:1 menu:1 item_id:' + new_id);
                if (response.item_loop.length > 0)
                    if (response.item_loop[0].presetParams)
                        return response.item_loop[0].presetParams.favorites_url;
                console.error(this._lc, "Couldn't add spotify item with id: " + parsed_id.id);
            }

            return data.items[0].url;
        } else if (parsed_id.type == "playlist") {
            let response = await this.command('playlists 0 100 tags:u:playlist');
            let data = this.parseAdvancedQueryResponse(response, 'id');
            for (var key in data.items) {
                if (data.items[key].id == parsed_id.id)
                    return data.items[key].url
            }
            console.error(this._lc, "Couldn't find playlist with id: " + parsed_id.id);
        } else if (parsed_id.type == "year" ) {
            return "db:year.id=" + parsed_id.id;
        } else if (parsed_id.type == "artist" ||
                   parsed_id.type == "album" ||
                   parsed_id.type == "genre" ||
                   parsed_id.type == "folder") {
            const itemMap = [{ name: 'Artists', cmd: 'artists', next_cmd: 'albums', filter_key: "artist_id", name_key: 'artist', split_key: 'id', id_key: 'artist', db_filter: 'db:contributor.name' },
                             { name: 'Albums', cmd: 'albums', next_cmd: 'tracks', filter_key: "album_id", name_key: 'title', split_key: 'id', id_key: 'album', db_filter: 'db:album.title' },
                             { name: 'Tracks', cmd: 'tracks', next_cmd: '', filter_key: "track_id", name_key: 'title', split_key: 'id', id_key: 'url' },
                             { name: 'Years', cmd: 'years', next_cmd: 'artists', filter_key: "year", name_key: 'year', split_key: 'year', id_key: 'year', db_filter: 'db:year.id' },
                             { name: 'Genres', cmd: 'genres', next_cmd: 'artists', filter_key: "genre_id", name_key: 'genre', split_key: 'id', id_key: 'genre', db_filter: 'db:genre.name' },
                             { name: 'Folders', cmd: 'musicfolder', next_cmd: 'musicfolder', filter_key: "folder_id", name_key: 'title', split_key: 'id', id_key: 'folder' }
                            ];
            let cur_config = itemMap.find(element => parsed_id.type == element.id_key);
            let cmd = cur_config.cmd;
            let filter = " " + cur_config.filter_key + ':' +  parsed_id.id;
            let response = await this.command(cmd + ' 0 100 tags:uKjJt' + filter);
            let data = this.parseAdvancedQueryResponse(response, config.split_key);
            let url = data.items[0].url;
            if (url)
                return url;
            console.log(this._lc, data);

            let name = data.items[0][cur_config.name_key];
            if (cur_config.db_filter)
                return cur_config.db_filter + "=" + name;
        }

        console.log(this._lc, "Can't store " + parsed_id.type + " in favorites");
        return undefined;
    }
}
