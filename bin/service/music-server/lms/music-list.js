'use strict';

const LMSClient = require('./lms-client');

module.exports = class List {
  constructor(musicServer, url, zone_id) {
    this._musicServer = musicServer;
    this._url = url;
    this._zone_id = zone_id;
    if (url.endsWith("favorites"))
        this._client = new LMSClient(this._zone_id);

    this._total = Infinity;
    this._items = [];

    this._last = Promise.resolve();
  }

  reset(start = 0) {
    this._total = Infinity;
    this._items.splice(start, Infinity);
  }

  async get(start, length) {
//    const items = this._items;
//    const end = start + (length || 1);

//    while (items.length < this._total && items.length < end) {
//      let chunk = {items: [], total: 0};

//      try {
//        chunk = await this._call('GET', this._url + '/' + items.length);
//      } catch (err) {
//        console.error('[ERR!] Could not fetch list fragment: ' + err.message);
//      }

//      this._items.splice(items.length, Infinity, ...chunk.items);
//      this._total = chunk.total;
//    }

    let items = [];
    if (this._client) {
        let response = await this._client.command('favorites items ' + start + " " + length + " want_url%3A1");
        let obj = this._client.parseAdvancedQueryResponse(response, 'id', ['title']);
        this._total = obj.count;
        items = obj.items;
    }

    let processed = []
    for (var key in items) {
      processed.push({
                    id: items[key].id,
                    title: items[key].name,
                    image: await this._client.artworkFromUrl(items[key].url)
                })
    }

    //Replace the correct items ?
    //How to emit changes in the list or a complete reset ?

    return {
      total: this._total,
      items: processed,
    };
  }

  async insert(position, ...items) {
    await this._client.command('favorites add item_id%3A' + position + 'title%3A' + items.title + ' url%3A' + items.id);
  }

  async replace(position, ...items) {
     await this.delete(position, 1)
     await this.insert(position, ...items)
  }

  async delete(position, length) {
    for (var i=0; i<length; i++) {
        // TODO Test whether we need to really increase the position
        await this._client.command('favorites delete item_id%3A' + position + i);
    }
  }
};
