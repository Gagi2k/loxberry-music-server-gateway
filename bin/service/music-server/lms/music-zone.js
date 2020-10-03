'use strict';

const MusicList = require('./music-list');
const LMSClient = require('./lms-client');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync("config.json"));

module.exports = class MusicZone {
  constructor(musicServer, id) {
    this._musicServer = musicServer;
    this._id = id;

    this._power = 'on';
    this._updateTime = NaN;

    this._favoriteId = 0;
    this._zone_mac = config.zone_map[id];

    this._player = {
      id: '',
      mode: 'stop',
      time: 0,
      volume: 0,
      repeat: 0,
      shuffle: 0,
    };

    this._track = this._getEmptyTrack();

    this._favorites = new MusicList(musicServer, this._url() + '/favorites', this);
    this._queue = new MusicList(musicServer, this._url() + '/queue', this);
    this._client = new LMSClient(this._zone_mac, (data) => { this.onLMSNotification(data); });

    // We have to query for state regardless of the internal one, because the
    // state could be updated from the outside.
    //setInterval(this.getState.bind(this), 5000);
    if (!this._zone_mac) {
        console.error("No MAC configured for zone " + id);
        return;
    }

    this.getState();
  }

  async onLMSNotification(data) {
    console.log("NOTIFICATION ", data)
    // Current song changed
    if (data.startsWith("playlist newsong") || data.startsWith("newmetadata")) {
        await this.getCurrentTrack();
        await this.getCurrentTime();
        this._pushAudioEvent();
    } else if (data.startsWith("time")) {
        await this.getCurrentTime();
        this._pushAudioEvent();
    } else if (data.startsWith("playlist shuffle") ||
               data.startsWith("playlist repeat")  ||
               data.startsWith("mixer volume")) {
        await this.getState();
        this._pushAudioEvent();
    }
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
        console.error('[ERR!] Invalid reply for "equalizer": ' + err.message);
      } else {
        console.error(
          '[ERR!] Default behavior for "equalizer": ' + err.message,
        );
      }

      return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    }
  }

  async getCurrentTime() {
        let time = parseFloat(await this._client.command('time ?'))
        this._player.time = time * 1000
        this._updateTime = Date.now()
  }

  // A Track is always updated as a whole, all others are updated when changed
  async getCurrentTrack() {
        let path = await this._client.command('path ?')
        let title = await this._client.command('title ?')
        let artist = await this._client.command('artist ?')
        let album = await this._client.command('album ?')
        let duration = parseFloat(await this._client.command('duration ?'))
        let artwork_url = await this._client.artworkFromUrl(path);
        let index = await this._client.command('playlist index ?')

        console.log("ARTWORK", artwork_url)

        duration = duration * 1000

        this._track = {
            "id": "track:" + path,
            "title": title,
            "album": album,
            "artist": artist,
            "duration": duration,
            "image": artwork_url,
            "qindex": index
        }
        console.log(JSON.stringify(this._track))
  }

  async getState() {
        let volume = await this._client.command('mixer volume ?')
        let repeat = await this._client.command('playlist repeat ?')
        let shuffle = await this._client.command('playlist shuffle ?')
        let mode = await this._client.command('mode ?')

        this._player = {
            "id": "foo",
            "mode": mode,
            "time": 0,
            "volume": volume,
            "repeat": repeat,
            "shuffle": shuffle,
        }
        await this.getCurrentTime()
        console.log(JSON.stringify(this._player))

        await this.getCurrentTrack()

        this._musicServer.pushQueueEvent(this);
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

  getRepeat() {
    return this._player.repeat;
  }

  getShuffle() {
    return this._player.shuffle;
  }

  async alarm(type, volume) {
    const transaction = this._transaction();

    this._setMode('pause');

    transaction.end();

    try {
      await this._sendPlayerCommand('POST', '/alarm/' + type + '/' + volume);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error('[ERR!] Invalid reply for "alarm": ' + err.message);
        transaction.rollback();
      } else {
        console.error('[ERR!] Default behavior for "alarm": ' + err.message);
        this._setMode('play');
      }
    }
  }

  async equalizer(bands) {
    try {
      return await this._sendPlayerCommand('PUT', '/equalizer', bands);
    } catch (err) {
      if (err.type === 'BACKEND_ERROR') {
        console.error('[ERR!] Invalid reply for "equalizer": ' + err.message);
      } else {
        console.error(
          '[ERR!] Default behavior for "equalizer": ' + err.message,
        );
      }
    }
  }

  async play(id, favoriteId) {
    console.log("PLAY  ", id, favoriteId)

    var type = Math.floor(favoriteId / 1000000);
    var fav_id = favoriteId % 1000000;
    let parsed_id = this._client.parseId(id);

    console.log(type, fav_id)

    if (type == 0) {
        setMode('play')
        return;
    } else {
        if (parsed_id.type == "fav") {
            await this._client.command('favorites playlist play item_id%3A' + parsed_id.id);
            return;
        } else if (parsed_id.type == "playlist") {
            var str = "playlist_id%3A" + parsed_id.id;
            await this._client.command('playlistcontrol cmd:load ' + str);
            return;
        } else if (parsed_id.type == "url"){
            await this._client.command('playlist play ' + parsed_id.id);
            return;
        }
    }

    console.log("PLAYING THIS TYPE IS NOT IMPLEMENTED")
  }

  async pause() {
    this._setMode('pause');
  }

  async resume() {
    this._setMode('play');
  }

  async stop() {
    this._setMode('stop');
  }

  async time(time) {
    this._player.time = time;
    await this._client.command('time ' + this._player.time / 1000)

    this._pushAudioEvent();
  }

  async volume(volume) {
    this._player.volume = Math.min(Math.max(+volume, 0), 100);

    await this._client.command('mixer volume ' + this._player.volume)

    this._pushAudioEvent();
  }

  async repeat(repeat) {
    if (repeat === 0 || repeat === 1 || repeat === 2) {
      this._player.repeat = repeat;
    } else {
      this._player.repeat = (this._repeat + 1) % 3;
    }

    await this._client.command('playlist repeat ' + this._player.repeat)

    this._pushAudioEvent();
  }

  async shuffle(shuffle) {
    if (shuffle === 0 || shuffle === 1) {
      this._player.shuffle = shuffle;
    } else {
      this._player.shuffle = (this._shuffle + 1) % 2;
    }

    await this._client.command('playlist shuffle ' + this._player.shuffle)

    this._pushAudioEvent();
  }

  async previous() {
    await this._client.command('playlist index -1')
    this._pushAudioEvent();
  }

  async next() {
    // Just using +1 didn't work very reliable
    await this._client.command('playlist index +01')
    this._pushAudioEvent();
  }

  async power(power) {
    this._power = power;

    if (power === 'off') {
      await this.stop();
    }

    this._pushAudioEvent();
  }

  async _setMode(mode) {
    this._player.mode = mode;
    await this.getCurrentTime();

    await this._client.command('mode ' + this._player.mode)

//    if (mode !== 'stop') {
//      this.power('on');
//    }

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
      qindex: 0
    };
  }

  _url() {
    return '/zone/' + this._id;
  }
};
