'use strict';

const LMSClient = require('./lms-client');
const fs = require('fs');
const Mutex = require('async-mutex');

module.exports = class List {
  constructor(musicServer, url, zone) {
    this._musicServer = musicServer;
    this._url = url;
    this._zone = zone;
    this._zone_mac = zone ? zone._zone_mac : undefined
    this._mutex = new Mutex.Mutex();

    if (url.endsWith("favorites")) {
        if (!this._zone_mac) {
            this._client = new LMSClient(this._zone_mac, (data) => {
                 if (data.startsWith("favorites")) {
                     this.reset()
                     musicServer._pushFavoritesChangedEvent();
                 }
             });
            this.get_call = async (rootItem, start, length) => {
                console.log("GET FAVS")
                let response = await this._client.command('favorites items ' + start + ' ' + length + ' want_url:1');
                let data = this._client.parseAdvancedQueryResponse(response, 'id', ['title']);
                let items = data.items;
                data.items = []
                for (var key in items) {
                    // Filter all favorites which are folders
                    // This won't work if this function is called multiple times as the data.count
                    // would be wrong. Instead we should fetch all favs in one call (currently 50)
                    if (items[key].isaudio == "1") {
                        data.items.push({
                                           // If we don't have a url, we fallback to use the id instead
                                           // For example in folders
                                           id: items[key].url ? "url:" + items[key].url : "fav:" + items[key].id,
                                           title: items[key]["name"],
                                           image: await this._client.artworkFromUrl(items[key].url)
                                       })
                    } else {
                        data.count = data.count - 1
                    }
                }
                return data
            }
            this.insert_call = async (position, ...items) => {
                //TODO the items we are getting here might be playslists or other items which
                // don't use a track as an id, we need to resolve the track first from the id

                for (var i in items) {
                    await this._client.command('favorites add item_id:' + position + ' title:' + escape(items[i].title) + ' url:' + items[i].id);
                }
            }
            this.delete_call = async (position, length) => {
                for (var i=0; i<length; i++) {
                    // TODO Test whether we need to really increase the position
                    // TODO Check whether it is the position or the id which gets passed here
                    var item = +position + i
                    await this._client.command('favorites delete item_id:' + item);
                }
            }
        } else { // zone favorites
            let fileName = 'zone_favorite_' + this._zone._id + '.json'
            let fav_items = [{id:0, title: "Dummy"}]
            if (fs.existsSync(fileName)) {
                let rawdata = fs.readFileSync(fileName);
                fav_items = JSON.parse(rawdata);
            }

            this.get_call = async (rootItem, start, length) => {
                return { count: fav_items.length, items: fav_items };
            }
            this.insert_call = async (position, ...items) => {
                fav_items.splice(position, 0, ...items)
                let data = JSON.stringify(fav_items);
                fs.writeFileSync(fileName, data);
                this.reset()
                musicServer._pushRoomFavChangedEvents([this._zone]);
            }
            this.delete_call = async (position, length) => {
                fav_items.splice(position, length)
                let data = JSON.stringify(fav_items);
                fs.writeFileSync(fileName, data);
                this.reset()
                musicServer._pushRoomFavChangedEvents([this._zone]);
            }
        }
    } else if (url.endsWith("playlists")) {
        this._client = new LMSClient(this._zone_mac);
        this.get_call = async (rootItem, start, length) => {
            if (!rootItem) {
                let response = await this._client.command('playlists ' + start + ' ' + length + " tags:u:playlist");
                let data = this._client.parseAdvancedQueryResponse(response, 'id');
                let items = data.items;
                data.items = []
                for (var key in items) {
                    // Filter all temporary playlists
                    // This won't work if this function is called multiple times as the data.count
                    // would be wrong. Instead we should fetch all favs in one call (currently 50)
                    if (!items[key].playlist.startsWith("temp_")) {
                        data.items.push({
                                           id: "playlist:" + items[key].id,
                                           title: items[key]["playlist"],
                                           // playlists don't have a artwork
                                           image: undefined,
                                       })
                    } else {
                        data.count = data.count - 1
                    }
                }
                return data;
            } else {
                let parsed_id = this._client.parseId(rootItem.id);
                let response = await this._client.command('playlists tracks ' + start + ' ' + length + " playlist_id:" + parsed_id.id + " tags:uKJN");
                let data = this._client.parseAdvancedQueryResponse(response, 'playlist%20index');
                let items = data.items;
                data.items = []
                for (var key in items) {
                    data.items.push({
                                       id: "url:" + items[key].url,
                                       title: items[key].title,
                                       image: await this._client.extractArtwork(items[key].url, items[key]),
                                       type: 2 //File
                                   })
                }
                console.log(data);
                return data;
            }
        }
        this.insert_call = async (position, ...items) => {
            for (var i in items) {
                //Create a new playlist
                let response = await this._client.command('playlists new name:' + escape(items[i].title));
                const [ , id] = response.split("%3A")
                this.reset();
                musicServer._pushPlaylistsChangedEvent("playlist:" + id, "create", items[i].title);
            }
        }
        this.delete_call = async (position, length) => {
            // Instead of passing the position, we pass the playlist_id directly
            let parsed_id = this._client.parseId(position);
            await this._client.command('playlists delete playlist_id:' + parsed_id.id);
            this.reset();
            musicServer._pushPlaylistsChangedEvent(position, "delete");
        }
    } else if (url.endsWith("queue")) {
        this._client = new LMSClient(this._zone_mac, (data) => {
             if (data.startsWith("playlist load") || data.startsWith("playlist play") ||
                 data.startsWith("playlist delete") || data.startsWith("playlist move") ||
                 data.startsWith("playlist addtracks")) {
                console.log("TRIGGER QUEUE REFRESH")
                this.reset();
                musicServer.pushQueueEvent(this._zone)
             }
         });
        this.get_call = async (rootItem, start, length) => {
            console.log("QUEUE GET", start, length)
            let response = await this._client.command('status ' + start + ' ' + length + " tags:uKJN");
            let data = this._client.parseAdvancedQueryResponse(response, 'id', [''], "playlist_tracks");
            let items = data.items.slice(1);
            data.items = []
            for (var key in items) {
                data.items.push({
                                   id: "url:" + items[key].url,
                                   title: items[key].remote_title ? "" : items[key]["title"],
                                   station: items[key].remote_title,
                                   image: await this._client.extractArtwork(items[key].url, items[key])
                               })
            }
            return data
        }
        this.insert_call = async (position, ...items) => {
            for (var i in items) {
                let cmd = "insert"
                if (position == this._itemMap.get(undefined).total)
                    cmd = "add"

                let parsed_id = this._client.parseId(items[i].id);
                if (parsed_id.type == "url")
                    await this._client.command('playlist ' + cmd + ' ' + parsed_id.id);
                else if (parsed_id.type == "playlist")
                     await this._client.command('playlistcontrol cmd:' + cmd + ' playlist_id:' + parsed_id.id);
                else
                    await this._client.command('favorites playlist ' + cmd + ' item_id:' + parsed_id.id);
            }
        }
        this.move_call = async (position, destination) => {
            await this._client.command('playlist move ' + position + " " + destination);
        }
        this.delete_call = async (position, length) => {
            for (var i=0; i<length; i++) {
                // TODO Test whether we need to really increase the position
                // TODO Check whether it is the position or the id which gets passed here
                var item = +position + i
                await this._client.command('playlist delete ' + item);
            }
        }
    } else if (url.endsWith("library")) {
        this._client = new LMSClient(this._zone_mac);
        this.get_call = async (rootItem, start, length) => {
            var data = [];
            for (var i=0; i<10; i++) {
                data.push({ id: i, title: "FOO " + i, type:1});
            }

            return { count: data.length, items: data }
        }
    } else if (url.endsWith("radios")) {
        this._client = new LMSClient(this._zone_mac);
        this.get_call = async (rootItem, start, length) => {
            let response = await this._client.command('radios ' + start + ' ' + length);
            let data = this._client.parseAdvancedQueryResponse2(response, ["name", "icon", "type", "cmd", "weight"]);
            let items = data.items;
            data.items = []
            for (var key in items) {
                // Filter the search Folder
                if (items[key].cmd == "search") {
                    data.count--;
                    continue;
                }

                data.items.push({
                                   // Always 0, as this is indicates no item_id for the servicefolder command
                                   id: 0,
                                   cmd: items[key].cmd,
                                   name: unescape(items[key].name),
                                   icon: await this._client.extractArtwork(items[key].url, items[key])
                               })
            }
            return data
        }
    } else if (url.endsWith("services")) {
        this._client = new LMSClient(this._zone_mac);
        this.get_call = async (rootItem, start, length) => {
            let response = await this._client.command('spotty items 0 1');
            let data = this._client.parseAdvancedQueryResponse(response, 'id');
            if (data.count == 0)
                return { count: 0, items: [] };
            return { count: 1, items: [{ id: 0, cmd: "spotify", user: "Standard User" }] };
        }
    } else if (url.endsWith("servicefolder")) {
        this._client = new LMSClient(this._zone_mac);
        this.get_call = async (rootItem, start, length) => {
            if (rootItem.cmd == "spotify")
                rootItem.cmd = "spotty";
            var itemId = rootItem.id ? "item_id:" + this._client.parseId(rootItem.id).id : ""
            let response = await this._client.command(rootItem.cmd + ' items ' + start + ' ' + length + ' want_url:1 ' + itemId);
            let data = this._client.parseAdvancedQueryResponse(response, 'id');
            let items = data.items.slice(1);
            data.items = []
            for (var key in items) {
                data.items.push({
                                   id: "service/" + rootItem.cmd + ":" + items[key].id,
                                   title: unescape(items[key].name),
                                   image: await this._client.extractArtwork(items[key].url, items[key]),
                                   type: items[key].type == "playlist" ? 11 //playlist
                                                                       : items[key].isaudio == "1" ? 2 : 1 //folder
                               })
            }
            return data
        }
    }

    this.reset();
  }

  reset(start = 0) {
    this._itemMap = new Map;
    this._itemMap.set(undefined, {
                          total: Infinity,
                          items: [],
                      })
  }

  async get(rootItem, start, length) {
    console.log("GET", rootItem, start, length)
    const end = start + (length || 1);

    await this._mutex.runExclusive(async () => {
        let _total, _items = undefined;
        if (this._itemMap.has(rootItem)) {
            let data = this._itemMap.get(rootItem);
            _total = data.total;
            _items = data.items;
        } else {
            _total = Infinity;
            _items = [];
        }

        if (_items.length < _total && _items.length < end && this.get_call) {
            let chunk = await this.get_call(rootItem, start, length || 1)

            console.log(chunk.count, _items.length, JSON.stringify(chunk.items))

            _items.splice(_total.length, 0, ...chunk.items)
            _total = chunk.count,
            this._itemMap.set(rootItem, {
                                  total: _total,
                                  items: _items
                              });
        }
    });

    let {total, items} = this._itemMap.get(rootItem);

    return {
      total: total,
      items: items.slice(start, end),
    };

  }

  async insert(position, ...items) {
    console.log("INSERT", position, ...items)
    if (!this.insert_call) {
        console.log("NOT IMPLEMENTED!")
        return;
    }

    await this.insert_call(position, ...items)
  }

  async replace(position, ...items) {
     console.log("REPLACE", position, ...items)
     await this.delete(position, 1)
     await this.insert(position, ...items)
  }

  async move(position, destination) {
    console.log("MOVE", position, destination)
    if (!this.move_call) {
        console.log("NOT IMPLEMENTED!")
        return;
    }

    await this.move_call(position, destination)
  }

  async delete(position, length) {
    console.log("DELETE", position, length)
    if (!this.delete_call) {
        console.log("NOT IMPLEMENTED!")
        return;
    }
    await this.delete_call(position, length)
  }
};
