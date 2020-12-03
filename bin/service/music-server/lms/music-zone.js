'use strict';

const MusicList = require('./music-list');
const LMSClient = require('./lms-client');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync("config.json"));

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

module.exports = class MusicZone {
  constructor(musicServer, id) {
    this._musicServer = musicServer;
    this._id = id;

    this._updateTime = NaN;

    this._zone_mac = config.zone_map[id];
    this._cfgFileName = "zone_config_" + this._id + ".json";
    this._audioDelay = 0;

    this._player = {
      id: '',
      mode: 'stop',
      time: 0,
      volume: 0,
      repeat: 0,
      shuffle: 0,
      power: 0
    };

    this._zone_cfg = {
        defaultVolume: 15,
        maxVolume: 100,
        equalizer: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        lastRoomFav: 0,
    }

    this.readConfig();

    this._track = this._getEmptyTrack();

    this._favorites = new MusicList(musicServer, this._url() + '/zone_favorites', this);
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
    this.fetchAudioDelay();
  }

  readConfig() {
    if (fs.existsSync(this._cfgFileName)) {
        let rawdata = fs.readFileSync(this._cfgFileName);
        this._zone_cfg = Object.assign(this._zone_cfg, JSON.parse(rawdata));
    }
  }

  saveConfig() {
    let data = JSON.stringify(this._zone_cfg);
    fs.writeFileSync(this._cfgFileName, data);
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
               data.startsWith("playlist stop")  ||
               data.startsWith("playlist pause")  ||
               data.startsWith("playlist play")  ||
               data.startsWith("mode ")  ||
               data.startsWith("pause ")  ||
               data.startsWith("play ")  ||
               data.startsWith("playlist jump")  ||
               data.startsWith("playlist open")  ||
               data.startsWith("mixer volume") ||
               data.startsWith("client new") ||
               data.startsWith("power ")) {
        await this.getState();
        this._pushAudioEvent();
    } else if (data.startsWith("prefset server playDelay")) {
        this.fetchAudioDelay();
    }
  }

  async getEqualizer() {
      return this._zone_cfg.equalizer;
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
        let index = await this._client.command('playlist index ?')
        let station = ""


        let response = await this._client.command('songinfo 0 100 url:' + path)
        let item = this._client.parseAdvancedQueryResponse(response).items[0];
        let artwork_url = this._client.extractArtwork(path, item);
        if (item.remote_title)
            station = item.remote_title

        duration = duration * 1000

        this._track = {
            "id": "url:" + path,
            "title": title,
            "album": album,
            "artist": artist,
            "duration": duration,
            "image": artwork_url,
            "qindex": index,
            "station": station
        }
        console.log(JSON.stringify(this._track))
  }

  async getState() {
        let volume = await this._client.command('mixer volume ?')
        let repeat = await this._client.command('playlist repeat ?')
        let shuffle = await this._client.command('playlist shuffle ?')
        let power = await this._client.command('power ?')
        let mode = await this._client.command('mode ?')

        volume = parseInt(volume);
        let maxVolume = parseInt(this._zone_cfg.maxVolume);
        if (volume > maxVolume) {
            await this.volume(maxVolume);
            volume = maxVolume;
        }

        this._player = {
            "id": "zone" + this._id,
            "mode": mode,
            "time": 0,
            "volume": volume,
            "defaultVolume": parseInt(this._zone_cfg.defaultVolume),
            "maxVolume": maxVolume,
            "repeat": repeat,
            "shuffle": shuffle,
            "power": +power,
        }
        await this.getCurrentTime()
        console.log(JSON.stringify(this._player))

        await this.getCurrentTrack()
  }

  getPower() {
    return this._player.power ? "on" : "off";
  }

  getFavoriteId() {
    return this._zone_cfg.lastRoomFav;
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
    return this._zone_cfg.defaultVolume;
  }

  getMaxVolume() {
    return this._zone_cfg.maxVolume;
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

  async fetchAudioDelay() {
      this._audioDelay = await this._client.command('playerpref playDelay ?')
  }

  async alarm(type, volume) {
    this._client.execute_script("playAlarmSound", { zones: this._id, type, volume })
  }

  async tts(language, text, volume) {
    this._client.execute_script("playTTS", { zones: this._id, language, text, volume })
  }

  async equalizer(bands) {
    this._zone_cfg.equalizer = bands;
    this.saveConfig();

    this._client.execute_script("changeEqualizer", { zones: this._id })
  }

  async play(id, favoriteId) {
    console.log("PLAY  ", id, favoriteId)
    this._zone_cfg.lastRoomFav = favoriteId;
    this.saveConfig();

    var type = Math.floor(favoriteId / 1000000);
    var fav_id = favoriteId % 1000000;

    if (type == 0) {
        this._setMode('play')
        return;
    }

    if (id == -1)
        return;

    let parsed_id = this._client.parseId(id);

    console.log(type, fav_id)

    if (parsed_id.type == "fav") {
        await this._client.command('favorites playlist play item_id:' + parsed_id.id);
        return;
    } else if (parsed_id.type == "url"){
        await this._client.command('playlist play ' + parsed_id.id);
        return;
    } else if (parsed_id.type.startsWith("service")){
        const [, cmd] = parsed_id.type.split("/");
        await this._client.command(cmd + ' playlist play item_id:' + parsed_id.id);
        return;
    } else if (parsed_id.type == "playlist" ||
               parsed_id.type == "artist" ||
               parsed_id.type == "album" ||
               parsed_id.type == "year" ||
               parsed_id.type == "genre" ||
               parsed_id.type == "folder") {
        var str = parsed_id.type + "_id:" + parsed_id.id;
        await this._client.command('playlistcontrol cmd:load ' + str);
        return;
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

  async sleep(time) {
    await this._client.command('sleep ' + time)

    this._pushAudioEvent();
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

  async defaultVolume(volume) {
    this._zone_cfg.defaultVolume = Math.min(Math.max(+volume, 0), 100);

    this.saveConfig();

    this._client.execute_script("changeDefaultVolume", { zones: this._id,
                                                         defaultVolume: this._zone_cfg.defaultVolume})

    this._pushAudioEvent();
  }

  async maxVolume(volume) {
    this._zone_cfg.maxVolume = Math.min(Math.max(+volume, 0), 100);

    this.saveConfig();

    this._client.execute_script("changeMaxVolume", { zones: this._id,
                                                     maxVolume: this._zone_cfg.maxVolume})

    this._pushAudioEvent();
  }

  async audioDelay(delay) {
    await this._client.command('playerpref playDelay ' + delay)
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

  async setCurrentIndex(index) {
    await this._client.command('playlist index ' + index)
    this._pushAudioEvent();
  }

  async power(power) {
    await this._client.command('power ' + ((power == "on") ? 1 : 0))

    //If we are in a sync group, powering on a slave will change the mode already to
    //playing. Get the new state first before trying to change it.
    await this.getState();

    // Resum playing when the zone is turned on
    if (power == "on")
        await this.resume();
    else
        await this.pause();

    this._pushAudioEvent();
  }

  async sync(zones) {
    var macs = []
    for (var i in zones) {
        if (!zones[i])
            continue;
        var mac = config.zone_map[zones[i]];
        if (mac)
            macs.push(mac);
    }

    if (macs.length) {
        this.unSync();

        for (var i in macs)
            await this._client.command('sync ' + macs[i]);
    }
  }

  async unSync() {
    await this._client.command('sync -')
  }

  async _setMode(mode) {
    await this.getCurrentTime();

    console.log("POWER", this._player.power);
    if (this.getPower() == "off" && mode == "play") {
        await this.power("on");
    }

    console.log("CURRENT MODE: " + this._player.mode + " NEW MODE: " + mode)
    if (this._player.mode == "pause" && mode == "play")
        await this._client.command('pause 0');
    else if (this._player.mode != mode)
        await this._client.command('mode ' + mode);
    this._player.mode = mode;

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
