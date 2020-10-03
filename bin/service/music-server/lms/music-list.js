'use strict';

const LMSClient = require('./lms-client');
const fs = require('fs');

module.exports = class List {
  constructor(musicServer, url, zone) {
    this._musicServer = musicServer;
    this._url = url;
    this._zone = zone;
    this._zone_id = zone ? zone._zone_id : undefined

    if (url.endsWith("favorites")) {
        if (!this._zone_id) {
            this._client = new LMSClient(this._zone_id, (data) => {
                 if (data.startsWith("favorites")) {
                     this.reset()
                     musicServer._pushFavoritesChangedEvent();
                 }
             });
            this.get_call = async (start, length) => {
                console.log("GET GLOBAL FAV")
                let response = await this._client.command('favorites items ' + start + ' ' + length + ' want_url%3A1');
                let data = this._client.parseAdvancedQueryResponse(response, 'id', ['title']);
                let items = data.items;
                data.items = []
                for (var key in items) {
                    data.items.push({
                                       id: items[key].id,
                                       title: items[key]["name"],
                                       image: await this._client.artworkFromUrl(items[key].url)
                                   })
                }
                return data
            }
            this.insert_call = async (position, ...items) => {
                await this._client.command('favorites add item_id%3A' + position + 'title%3A' + items.title + ' url%3A' + items.id);
            }
            this.delete_call = async (position, length) => {
                for (var i=0; i<length; i++) {
                    // TODO Test whether we need to really increase the position
                    // TODO Check whether it is the position or the id which gets passed here
                    var item = +position + i
                                    console.log("CALL", 'favorites delete item_id%3A' + item)
                    await this._client.command('favorites delete item_id%3A' + item);
                }
            }
        } else { // zone favorites
            console.log("CREATE ROOM FAV")
            let fileName = 'zone_favorite_' + this._zone._id + '.json'
            let fav_items = [{id:0, title: "Dummy"}]
            if (fs.existsSync(fileName)) {
                let rawdata = fs.readFileSync(fileName);
                fav_items = JSON.parse(rawdata);
            }

            this.get_call = async (start, length) => {
                console.log("ROOM FAV", fav_items)
                return { count: fav_items.length, items: fav_items };
            }
            this.insert_call = async (position, ...items) => {
                console.log("INSERT FAV", position, ...items)
                fav_items.splice(fav_items.length, 0, ...items)
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
        this._client = new LMSClient(this._zone_id);
        this.get_call = async (start, length) => {
            let response = await this._client.command('playlists ' + start + ' ' + length);
            let data = this._client.parseAdvancedQueryResponse(response, 'id');
            let items = data.items;
            data.items = []
            for (var key in items) {
                data.items.push({
                                   id: items[key].id,
                                   title: items[key]["playlist"],
                                   image: await this._client.artworkFromUrl(items[key].url)
                               })
            }
            return data
        }
    } else if (url.endsWith("queue")) {
        this._client = new LMSClient(this._zone_id, (data) => {
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
                data.items.push({
                                   id: items[key].id,
                                   title: items[key]["playlist"],
                                   image: await this._client.artworkFromQueueIndex(key)
                               })
            }
            return data
        }
        this.title_prop = 'title'
    } else if (url.endsWith("library")) {
        this._client = new LMSClient(this._zone_id);
        this.get_call = async (start, length) => {
            var data = [];
            for (var i=0; i<10; i++) {
                data.push({ id: i, title: "FOO " + i});
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
    const items = this._items;
    const end = start + (length || 1);

    while (this._items.length < this._total && this._items.length < end) {
        let chunk = {items: [], total: 0};

        if (this.get_call) {
            let obj = await this.get_call(start, length)
            chunk.total = obj.count;
            chunk.items = obj.items;
        }

        console.log(chunk.total, items.length, JSON.stringify(chunk.items))

      this._items.splice(items.length, 0, ...chunk.items);
      this._total = chunk.total;
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
