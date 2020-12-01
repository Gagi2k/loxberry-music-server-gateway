'use strict';

const MusicList = require('./music-list');

module.exports = class MusicMaster {
  constructor(musicServer) {
    this._musicServer = musicServer;

    this._inputs = new MusicList(this, '/inputs');
    this._favorites = new MusicList(this, '/favorites');
    this._playlists = new MusicList(this, '/playlists');
    this._library = new MusicList(this, '/library');
    this._radios = new MusicList(musicServer, '/radios');
    this._services = new MusicList(musicServer, '/services');
    this._serviceFolder = new MusicList(musicServer, '/servicefolder');

    this._last = Promise.resolve();
  }

  getInputList() {
    return this._inputs;
  }

  getFavoriteList() {
    return this._favorites;
  }

  getPlaylistList() {
    return this._playlists;
  }

  getLibraryList() {
    return this._library;
  }

  getRadioList() {
    return this._radios;
  }

  getServiceList() {
    return this._services;
  }

  getServiceFolderList() {
    return this._serviceFolder;
  }

  getSyncGroups() {
    return [];
  }

  async scanStatus() {
    return false;
  }

  async rescanLibrary() {

  }

  // error: returnValue
  // NONE: 0,
  // NON_EXISTENT: 1,
  // UNREACHABLE: 2,
  // INVALIDE_CREDS: 12
  async addNetworkShare(config) {
     return 0;
  }

  async getSearchableTypes() {
    // Every key corresponds to one search == one list of result
    // The sample does three searches
    // Every key contains a list of categories which should be searched in
    // All of this is passed to the search function
    return {
        spotify: ['all'],
        local: ['all'],
        radios: ['all']
    }
  }

  async search(type, category, search, start, length) {
    let chunk = {items: [], total: 0};

    try {
      chunk = await this._call('GET', '/search/' + type + '/' + category + '/' + search + '/' + start + '/' + length);
    } catch (err) {
      console.error('[ERR!] Could not fetch search result: ' + err.message);
    }

    return {
      total: chunk.total,
      items: chunk.items,
    };
  }

  async playUploadedFile(path, zones) {
    try {
      await this._call(
        'POST',
        '/audio/grouped/playuploadedfile/' + encodeURIComponent(path) + '/' + zones.join('/'),
      );
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error('[ERR!] Invalid reply for "audio/grouped/playuploadedfile": ' + err.message);
      } else {
        console.error('[ERR!] Default behavior for "audio/grouped/playuploadedfile": ' + err.message);
      }
    }
  }

  _call() {
    const callback = () => this._musicServer.call(...arguments);

    return (this._last = this._last.then(callback, callback));
  }
}
