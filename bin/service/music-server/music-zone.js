'use strict';

const MusicList = require('./music-list');

const Log = require("./log");
const console = new Log;

module.exports = class MusicZone {
  constructor(musicServer, id, parent) {
    this._musicServer = musicServer;
    this._id = id;
    this._lc = parent.loggingCategory().extend("ZONE-" + id);

    this._power = 'on';
    this._updateTime = NaN;

    this._favoriteId = 0;
    this._audioDelay = 0;

    this._player = {
      id: '',
      mode: 'stop',
      time: 0,
      volume: 50,
      defaultVolume: 15,
      maxVolume: 100,
      repeat: 0,
      shuffle: 0,
    };

    this._track = this._getEmptyTrack();

    this._favorites = new MusicList(musicServer, this._url() + '/favorites', this);
    this._queue = new MusicList(musicServer, this._url() + '/queue', this);

    // We have to query for state regardless of the internal one, because the
    // state could be updated from the outside.
    setInterval(this.getState.bind(this), 5000);

    this.getState();
  }

  loggingCategory() {
    return this._lc;
  }

  async getEqualizer() {
    try {
      const equalizer = await this._musicServer.call(
        'GET',
        this._url() + '/equalizer',
      );

      if (
        !Array.isArray(equalizer) ||
        equalizer.some((band) => typeof band !== 'number')
      ) {
        const error = new Error(
          'Invalid equalizer format: needs to be an array of 10 numbers',
        );

        error.type = 'BACKEND_ERROR';

        throw error;
      }

      return equalizer;
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "equalizer": ' + err.message);
      } else {
        console.error(this._lc,
          'Default behavior for "equalizer": ' + err.message,
        );
      }

      return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    }
  }

  async getState() {
    try {
      await this._sendPlayerCommand('GET', '/state');
    } catch (err) {this._lc,
      console.error('Could not get player "state": ' + err.message);
    }
  }

  getPower() {
    return this._power;
  }

  getFavoriteId() {
    return this._favoriteId;
  }

  getFavoritesList() {
    return this._favorites;
  }

  getQueueList() {
    return this._queue;
  }

  getTrack() {
    return this._track;
  }

  getMode() {
    return this._player.mode;
  }

  getTime() {
    const delta = Date.now() - this._updateTime;
    const player = this._player;

    return Math.min(
      player.time + (player.mode === 'play' ? delta : 0),
      this._track.duration,
    );
  }

  getVolume() {
    return this._player.volume;
  }

  getDefaultVolume() {
    return this._player.defaultVolume;
  }

  getMaxVolume() {
    return this._player.maxVolume;
  }

  getRepeat() {
    return this._player.repeat;
  }

  getShuffle() {
    return this._player.shuffle;
  }

  getAudioDelay() {
    return this._audioDelay;
  }

  async alarm(type, volume) {
    const transaction = this._transaction();

    this._setMode('pause');

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/alarm/' + type + '/' + volume);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "alarm": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "alarm": ' + err.message);
        this._setMode('play');
      }
    }
  }

  async tts(language, text) {
    try {
      await this._sendPlayerCommand('POST', '/tts/' + zones + '/' + language + '/' + text);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "tts": ' + err.message);
      } else {
        console.error(this._lc, 'Default behavior for "tts": ' + err.message);
      }
    }
  }

  async equalizer(bands) {
    try {
      return await this._sendPlayerCommand('PUT', '/equalizer', bands);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "equalizer": ' + err.message);
      } else {
        console.error(this._lc,
          'Default behavior for "equalizer": ' + err.message,
        );
      }
    }
  }

  async playRoomFav(id, favoriteId, name) {
    this.play(id, favoriteId);
  }

  async play(id, favoriteId) {
    const transaction = this._transaction();

    this._favoriteId = favoriteId;

    this._track = this._getEmptyTrack();
    this._player.time = 0;
    this._setMode('buffer');

    transaction.end();

    try {
      await this._sendPlayerCommand(
        'POST',
        id === null ? '/play' : '/play/' + encodeURIComponent(id),
      );
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "play": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "play": ' + err.message);
        this._setMode('play');
      }
    }
  }

  async pause() {
    const transaction = this._transaction();

    this._setMode('pause');

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/pause');
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "pause": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "pause": ' + err.message);
      }
    }
  }

  async resume() {
    const transaction = this._transaction();

    this._player.time = this.getTime();
    this._setMode('buffer');

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/resume');
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "resume": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "resume": ' + err.message);
        this._setMode('play');
      }
    }
  }

  async stop() {
    const transaction = this._transaction();

    this._setMode('stop');

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/stop');
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "stop": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "stop": ' + err.message);
      }
    }
  }

  async sleep(time) {
    try {
      await this._sendPlayerCommand('POST', '/sleep/' + time);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "sleep": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "sleep": ' + err.message);
      }
    }
  }

  async time(time) {
    const transaction = this._transaction();

    this._player.time = time;
    this._setMode('buffer');

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/time/' + time);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "time": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "time": ' + err.message);
        this._setMode('play');
        this._player.time = time;
        this._updateTime = Date.now();
      }
    }

    this._pushAudioEvent();
  }

  async volume(volume) {
    const transaction = this._transaction();

    this._player.volume = Math.min(Math.max(+volume, 0), 100);

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/volume/' + this._player.volume);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "volume": ' + err.message);
        transaction.rollback();
      } else {this._lc,
        console.error('Default behavior for "volume": ' + err.message);
      }
    }

    this._pushAudioEvent();
  }

  async defaultVolume(volume) {
    const transaction = this._transaction();

    this._player.defaultVolume = Math.min(Math.max(+volume, 0), 100);

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/defaultVolume/' + this._player.volume);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "defaultVolume": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "defaultVolume": ' + err.message);
      }
    }

    this._pushAudioEvent();
  }

  async maxVolume(volume) {
    const transaction = this._transaction();

    this._player.maxVolume = Math.min(Math.max(+volume, 0), 100);

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/maxVolume/' + this._player.volume);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "maxVolume": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "maxVolume": ' + err.message);
      }
    }

    this._pushAudioEvent();
  }

  async audioDelay(delay) {
    const transaction = this._transaction();

    this._audioDelay = delay;

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/audioDelay/' + delay);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "audioDelay": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "audioDelay": ' + err.message);
      }
    }

    this._pushAudioEvent();
  }

  async repeat(repeat) {
    const transaction = this._transaction();

    if (repeat === 0 || repeat === 1 || repeat === 2) {
      this._player.repeat = repeat;
    } else {
      this._player.repeat = (this._repeat + 1) % 3;
    }

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/repeat/' + repeat);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "repeat": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "repeat": ' + err.message);
      }
    }

    this._pushAudioEvent();
  }

  async shuffle(shuffle) {
    const transaction = this._transaction();

    if (shuffle === 0 || shuffle === 1) {
      this._player.shuffle = shuffle;
    } else {
      this._player.shuffle = (this._shuffle + 1) % 2;
    }

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/shuffle/' + shuffle);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "shuffle": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "shuffle": ' + err.message);
      }
    }

    this._pushAudioEvent();
  }

  async previous() {
    const transaction = this._transaction();

    this._track = this._getEmptyTrack();
    this._player.time = 0;
    this._setMode('buffer');

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/previous');
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "previous": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "previous": ' + err.message);
        this._setMode('play');
      }
    }

    this._pushAudioEvent();
  }

  async next() {
    const transaction = this._transaction();

    this._track = this._getEmptyTrack();
    this._player.time = 0;
    this._setMode('buffer');

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/next');
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "next": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "next": ' + err.message);
        this._setMode('play');
      }
    }

    this._pushAudioEvent();
  }

  async setCurrentIndex(index) {
    const transaction = this._transaction();

    this._track = this._getEmptyTrack();
    this._player.time = 0;
    this._setMode('buffer');

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/setCurrentIndex/' + index);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "next": ' + err.message);
        transaction.rollback();
      } else {
        console.error(this._lc, 'Default behavior for "next": ' + err.message);
        this._setMode('play');
      }
    }

    this._pushAudioEvent();
  }

  async power(power) {
    this._power = power;

    if (power === 'off') {
      await this.stop();
    }

    this._pushAudioEvent();
  }

  async sync(zones) {
    try {
      await this._sendPlayerCommand('POST', '/sync/' + zones);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "sync": ' + err.message);
      } else {
        console.error(this._lc, 'Default behavior for "sync": ' + err.message);
      }
    }
    this._musicServer.pushAudioSyncEvent();
  }

  async unSync() {
    try {
      await this._sendPlayerCommand('POST', '/unsync/' + zones);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error(this._lc, 'Invalid reply for "unsync": ' + err.message);
      } else {
        console.error(this._lc, 'Default behavior for "unsync": ' + err.message);
      }
    }
    this._musicServer.pushAudioSyncEvent();
  }

  _setMode(mode) {
    this._player.mode = mode;
    this._player.time = this.getTime();
    this._updateTime = Date.now();

    if (mode !== 'stop') {
      this.power('on');
    }

    this._pushAudioEvent();
  }

  _pushAudioEvent() {
    if (!this._audioEventSent) {
      this._audioEventSent = true;

      setTimeout(() => {
        this._musicServer.pushAudioEvent(this);
        this._audioEventSent = false;
      }, 25);
    }
  }

  _pushRoomFavEvent() {
    if (!this._roomFavEventSent) {
      this._roomFavEventSent = true;

      setTimeout(() => {
        this._musicServer.pushRoomFavEvent(this);
        this._roomFavEventSent = false;
      }, 25);
    }
  }

  async _sendPlayerCommand(method, url, body) {
    const data = await this._musicServer.call(method, this._url() + url, body);
    const track = data.track || this._getEmptyTrack();

    if (JSON.stringify(this._track) !== JSON.stringify(data.track)) {
      this._track = track;
      this._musicServer.pushQueueEvent(this);
    }

    if (data.player) {
      this._setMode(data.player.mode);
      Object.assign(this._player, data.player);
      this._updateTime = Date.now();
    }

    this._pushAudioEvent();
    this._pushRoomFavEvent();
  }

  _transaction() {
    const currentPlayer = Object.assign({}, this._player);
    const currentTrack = Object.assign({}, this._track);
    let lastPlayer;
    let lastTrack;

    return {
      end() {
        lastPlayer = Object.assign({}, this._player);
        lastTrack = Object.assign({}, this._track);
      },

      rollback() {
        if (lastPlayer === null || lastTrack === null) {
          throw new ReferenceError('Transaction must be ended to rollback');
        }
      },
    };
  }

  _getEmptyTrack() {
    return {
      id: '',
      title: '',
      album: '',
      artist: '',
      duration: 0,
      image: null,
    };
  }

  _url() {
    return '/zone/' + this._id;
  }
};
