'use strict';

const MusicList = require('./music-list');

module.exports = class MusicMaster {
  constructor(musicServer) {

    this._inputs = new MusicList(this, '/inputs');
    this._favorites = new MusicList(this, '/favorites');
    this._playlists = new MusicList(this, '/playlists');
    this._library = new MusicList(this, '/library');
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
}
