'use strict';

const Log = require("log");
const console = new Log;

module.exports = class List {
  constructor(musicServer, url, parent) {
    this._musicServer = musicServer;
    this._url = url;
    this._lc = parent.loggingCategory().extend(url.split('/').pop().toUpperCase());

    this._total = Infinity;
    this._items = [];

    this._last = Promise.resolve();
  }

  // The events for changes needs to be handled by index.js
  canSendEvents() {
    return false;
  }

  reset(start = 0) {
    this._total = Infinity;
    this._items.splice(start, Infinity);
  }

  async get(rootItem, start, length) {
    const items = this._items;
    const end = start + (length || 1);

    while (items.length < this._total && items.length < end) {
      let chunk = {items: [], total: 0};

      try {
        chunk = await this._call('GET', this._url + '/' + items.length);
      } catch (err) {
        console.error(this._lc, 'Could not fetch list fragment: ' + err.message);
      }

      this._items.splice(items.length, Infinity, ...chunk.items);
      this._total = chunk.total;
    }

    return {
      total: this._total,
      items: items.slice(start, end),
    };
  }

  async insert(position, ...items) {
    try {
      await this._call('POST', this._url + '/' + position, items);
    } catch (err) {
      console.error(this._lc, 'Could not insert list fragment: ' + err.message);
    }

    this.reset();
  }

  async replace(position, ...items) {
    try {
      await this._call('PUT', this._url + '/' + position, items);
    } catch (err) {
      console.error(this._lc, 'Could not replace list fragment: ' + err.message);
    }

    this.reset();
  }

  async move(position, destination) {
    try {
      await this._call('POST', this._url + '/move/' + position + '/' + destination);
    } catch (err) {
      console.error(this._lc, 'Could not move list fragment: ' + err.message);
    }

    this.reset();
  }

  async delete(position, length) {
    try {
      await this._call('DELETE', this._url + '/' + position + '/' + length);
    } catch (err) {
      console.error(this._lc, 'Could not delete list fragment: ' + err.message);
    }

    this.reset();
  }

  async clear() {
    try {
      await this._call('DELETE', this._url + '/');
    } catch (err) {
      console.error(this._lc, 'Could not clear list: ' + err.message);
    }

    this.reset();
  }

  _call() {
    const callback = () => this._musicServer.call(...arguments);

    return (this._last = this._last.then(callback, callback));
  }
};
