'use strict';

const LMSClient = require('./lms-client');
const fs = require('fs');

module.exports = class List {
  constructor(musicServer, url, zone) {
    this._musicServer = musicServer;
    this._url = url;
    this._zone = zone;
    this._zone_mac = zone ? zone._zone_mac : undefined

    if (url.endsWith("favorites")) {
        if (!this._zone_mac) {
            this._client = new LMSClient(this._zone_mac, (data) => {
                 if (data.startsWith("favorites")) {
                     this.reset()
                     musicServer._pushFavoritesChangedEvent();
                 }
             });
            this.get_call = async (start, length) => {
                console.log("GET FAVS")
                let response = await this._client.command('favorites items ' + start + ' ' + length + ' want_url:1');
                let data = this._client.parseAdvancedQueryResponse(response, 'id', ['title']);
                let items = data.items;
                data.items = []
                for (var key in items) {
                    data.items.push({
                                       // If we don't have a url, we fallback to use the id instead
                                       // For example in folders
                                       id: items[key].url ? "url:" + items[key].url : "fav:" + items[key].id,
                                       title: items[key]["name"],
                                       image: await this._client.artworkFromUrl(items[key].url)
                                   })
                }
                return data
            }
            this.insert_call = async (position, ...items) => {
                console.log("INSERT FAV")
                await this._client.command('favorites add item_id:' + position + 'title:' + items.title + ' url:' + items.id);
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

            this.get_call = async (start, length) => {
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
        this.get_call = async (start, length) => {
            let response = await this._client.command('playlists ' + start + ' ' + length + " tags:u:playlist");
            let data = this._client.parseAdvancedQueryResponse(response, 'id');
            let items = data.items;
            data.items = []
            for (var key in items) {
                data.items.push({
                                   id: "url:" + items[key].url,
                                   title: items[key]["playlist"],
                                   image: await this._client.artworkFromUrl(items[key].url)
                               })
            }
            return data
        }
    } else if (url.endsWith("queue")) {
        this._client = new LMSClient(this._zone_mac, (data) => {
             if (data.startsWith("playlist loadtracks")) {
//             if (data.startsWith("playlist load")) {
                console.log("TRIGGER QUEUE REFRESH")
                this.reset();
                musicServer.pushQueueEvent(this._zone)
             }
         });
        this.get_call = async (start, length) => {
            let response = await this._client.command('status ' + start + ' ' + length);
            let data = this._client.parseAdvancedQueryResponse(response, 'id', [''], "playlist_tracks");
            let items = data.items.slice(1);
            data.items = []
            for (var key in items) {
                let path = await this._client.command('playlist path ' + key + ' ?')
                data.items.push({
                                   id: "url:" + path,
                                   title: items[key]["playlist"],
                                   image: await this._client.artworkFromUrl(path)
                               })
            }
            return data
        }
        this.title_prop = 'title'
    } else if (url.endsWith("library")) {
        this._client = new LMSClient(this._zone_mac);
        this.get_call = async (start, length) => {
            var data = [];
            for (var i=0; i<10; i++) {
                data.push({ id: i, title: "FOO " + i, type:1});
            }

            return { count: data.length, items: data }
        }
        this.title_prop = 'title'
    }

    this._total = Infinity;
    this._items = [];
  }

  reset(start = 0) {
    this._total = Infinity;
    this._items.splice(start, Infinity);
  }

  async get(start, length) {
    console.log("GET", start, length)
    const items = this._items;
    const end = start + (length || 1);

    while (length > 0 && this._items.length < this._total && this._items.length < end && this.get_call) {
        let chunk = await this.get_call(start, length)

        console.log(chunk.count, items.length, JSON.stringify(chunk.items))

      this._items.splice(items.length, 0, ...chunk.items);
      this._total = chunk.count;
    }

    return {
      total: this._total,
      items: this._items.slice(start, end),
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

  async delete(position, length) {
    console.log("DELETE", position, length)
    if (!this.delete_call) {
        console.log("NOT IMPLEMENTED!")
        return;
    }
    await this.delete_call(position, length)
  }
};
