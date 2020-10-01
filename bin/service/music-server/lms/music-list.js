'use strict';

const LMSClient = require('./lms-client');

module.exports = class List {
  constructor(musicServer, url, zone_id) {
    this._musicServer = musicServer;
    this._url = url;
    this._zone_id = zone_id;

    if (url.endsWith("favorites")) {
        this._client = new LMSClient(this._zone_id, (data) => {
             if (data.startsWith("favorites")) {
//                 if (this._zone_id)
//                     //TODO We need to have the zone object here
//                     musicServer._pushRoomFavChangedEvents();
//                 else
                     musicServer._pushFavoritesChangedEvent();
             }
         });
        this.get_call = async (start, length) => {
            let response = await this._client.command('favorites items ' + start + ' ' + length + ' want_url%3A1');
            return this._client.parseAdvancedQueryResponse(response, 'id', ['title']);
        }
        this.title_prop = 'name'
        this.insert_call = async (position, ...items) => {
            await this._client.command('favorites add item_id%3A' + position + 'title%3A' + items.title + ' url%3A' + items.id);
        }
        this.delete_call = async (position, length) => {
            for (var i=0; i<length; i++) {
                // TODO Test whether we need to really increase the position
                // TODO Check whether it is the position or the id which gets passed here
                await this._client.command('favorites delete item_id%3A' + position + i);
            }
        }
    } else if (url.endsWith("playlists")) {
        this._client = new LMSClient(this._zone_id);
        this.get_call = async (start, length) => {
            let response = await this._client.command('playlists ' + start + ' ' + length);
            return this._client.parseAdvancedQueryResponse(response, 'id');
        }
        this.title_prop = 'playlist'
    } else if (url.endsWith("queue")) {
        this._client = new LMSClient(this._zone_id);
        this.get_call = async (start, length) => {
//            let response = await this._client.command('playlist playlistsinfo');
//            let id = this._client.parseAdvancedQueryResponse(response)[0].id;
            let response = await this._client.command('status ' + start + ' ' + length);
            let data = this._client.parseAdvancedQueryResponse(response, 'id', [''], "playlist_tracks");
            return data;
        }
        this.title_prop = 'title'
    } else if (url.endsWith("library")) {
        this._client = new LMSClient(this._zone_id);
        this.get_call = async (start, length) => {
            var data = [];
            for (var i=0; i<10; i++) {
                data.push({ id: i, title: "FOO " + i, image: undefined });
            }

            return { count: data.length, items: data }
        }
        this.title_prop = 'title'
    }

    this._total = Infinity;
    this._items = [];
  }

  async get(start, length) {
    let items = [];
    if (this._client) {
        let obj = await this.get_call(start, length)
        this._total = obj.count;
        items = obj.items;
    }

    let processed = []
    for (var key in items) {
        if (!items[key].id)
            continue;
        processed.push({
                           id: items[key].id,
                           title: items[key][this.title_prop],
                           image: await this._client.artworkFromUrl(items[key].url)
                       })
    }
    console.log(this._total, JSON.stringify(processed))

    //Replace the correct items ?
    //How to emit changes in the list or a complete reset ?

    return {
      total: this._total,
      items: processed,
    };
  }

  async insert(position, ...items) {
    if (!this._client)
        return
    if (!this.insert_call) {
        console.log("NOT IMPLEMENTED!")
        return;
    }

    await this.insert_call(position, items)
  }

  async replace(position, ...items) {
    if (!this._client)
        return
     await this.delete(position, 1)
     await this.insert(position, ...items)
  }

  async delete(position, length) {
    if (!this._client)
        return
    if (!this.delete_call) {
        console.log("NOT IMPLEMENTED!")
        return;
    }
    await this.delete_call(position, length)
  }
};
