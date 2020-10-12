'use strict';

const MusicList = require('./music-list');

module.exports = class MusicMaster {
  constructor(musicServer) {
    this._musicServer = musicServer;

    this._inputs = new MusicList(musicServer, '/inputs');
    this._favorites = new MusicList(musicServer, '/favorites');
    this._playlists = new MusicList(musicServer, '/playlists');
    this._library = new MusicList(musicServer, '/library');

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
