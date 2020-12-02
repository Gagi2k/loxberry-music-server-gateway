'use strict';

const http = require('http');
const cors_proxy = require('cors-anywhere');
const querystring = require('querystring');
const websocket = require('websocket');
const fs = require('fs');
const os = require('os');
const NodeRSA = require('node-rsa');

const config = JSON.parse(fs.readFileSync("config.json"));

const MusicMaster = require(config.plugin == "lms" ? './lms/music-master' : './music-master');
const MusicZone = require(config.plugin == "lms" ? './lms/music-zone' : './music-zone');

const headers = {
  'Content-Type': 'text/plain; charset=utf-8',
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS, POST, GET, PUT",
    "Access-Control-Max-Age": 2592000, // 30 days,
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Credentials": "true"
};

const errors = {
  2: 'UNKNOWN_ERROR',
  3: 'REDIRECT_ERROR',
  4: 'UNIMPLEMENTED_ERROR',
  5: 'BACKEND_ERROR',
};

const BASE_DELTA = 1000000;

const BASE_FAVORITE_ZONE = 1 * BASE_DELTA;
const BASE_FAVORITE_GLOBAL = 2 * BASE_DELTA;
const BASE_PLAYLIST = 3 * BASE_DELTA;
const BASE_LIBRARY = 4 * BASE_DELTA;
const BASE_INPUT = 5 * BASE_DELTA;
const BASE_SERVICE = 6 * BASE_DELTA;

module.exports = class MusicServer {
  constructor(cfg) {
    const zones = [];

    this._config = cfg;
    this._zones = zones;

    this._imageStore = Object.create(null);

    this._wsConnections = new Set();
    this._miniserverIp = null;
    this._miniserverPort = null;
    this._hostIp = config.ip ? config.ip : os.hostname();

    // public and private key for encryption of passwords
    // generated on the fly if not passed in config
    if (config.publicKey && config.privateKey) {
        this._rsaKey = new NodeRSA();
        if (!fs.existsSync(config.privateKey))
            console.error("Private Key: " + config.privateKey + " doesn't exist!")
        if (!fs.existsSync(config.publicKey))
            console.error("Public Key: " + config.publicKey + " doesn't exist!")

        this._rsaKey.importKey(fs.readFileSync(config.privateKey), "private");
        this._rsaKey.importKey(fs.readFileSync(config.publicKey), "public");
    } else {
        this._rsaKey = new NodeRSA({b: 1024});
    }
    this._rsaKey.setOptions({encryptionScheme: 'pkcs1'});


    for (let i = 0; i < config.zones; i++) {
      zones[i] = new MusicZone(this, i + 1);
    }

    this._master = new MusicMaster(this);
  }

  start() {
    if (this._httpServer || this._wsServer || this._dgramServer) {
      throw new Error('Music server already started');
    }

    const httpServer = http.createServer(async (req, res) => {
      console.log('[HTTP] Received message: ' + req.url);

      if (req.method === "OPTIONS") {
           res.writeHead(200, headers);
           res.end();
           return;
      }

      const chunks = [];

      try {
        req.on('data', (chunk) => {
            chunks.push(chunk);
        });
        req.on('end', async () => {
            const data = Buffer.concat(chunks);
            res.writeHead(200, headers);
            res.end(await this._handler(req.url, data));
        });
      } catch (err) {
        res.writeHead(500, headers);
        res.end(err.stack);
      }
    });

    const wsServer = new websocket.server({
      httpServer,
      autoAcceptConnections: true,
    });

    wsServer.on('connect', (connection) => {
      this._wsConnections.add(connection);

      connection.on('message', async (message) => {
        console.log('[WSCK] Received message: ' + message.utf8Data);

        if (message.type !== 'utf8') {
          throw new Error('Unknown message type: ' + message.type);
        }

        connection.sendUTF(await this._handler(message.utf8Data));
      });

      connection.on('close', () => {
        this._wsConnections.delete(connection);
      });

      connection.send('LWSS V 2.3.9.2 | ~API:1.6~');

      this._pushAudioEvents(this._zones);
      this._pushAudioSyncEvents();
      this._pushQueueEvents(this._zones);
      this._pushRoomFavEvents(this._zones);
    });

    httpServer.listen(this._config.port);
    if (config.cors_port)
        cors_proxy.createServer().listen(config.cors_port)

    this._initSse();

    this._httpServer = httpServer;
    this._wsServer = wsServer;
  }

  call(method, uri, body = null) {
    const url = this._config.gateway + uri;

    const data =
      method === 'POST' || method === 'PUT'
        ? JSON.stringify(body, null, 2)
        : '';

    console.log('--> [CALL] Calling ' + method + ' to ' + url);

    return new Promise((resolve, reject) => {
      const req = http.request(
        url,

        {
          method,

          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json; charset=utf-8',
          },
        },

        (res) => {
          const chunks = [];

          res.on('data', (chunk) => chunks.push(chunk));

          res.on('end', () => {
            if (res.statusCode !== 200) {
              const error = new Error('Wrong HTTP code: ' + res.statusCode);

              error.type = errors[Math.floor(res.statusCode / 100)];
              error.code = res.statusCode;

              return reject(error);
            }

            try {
              resolve(JSON.parse(Buffer.concat(chunks)));
            } catch (err) {
              reject(err);
            }
          });

          res.on('error', reject);
        },
      );

      req.on('error', reject);
      req.end(data);
    });
  }

  async pushAudioEvent(zone) {
    this._pushAudioEvents([zone]);

    const zoneId = this._zones.indexOf(zone) + 1;
    const syncInfo = this._getSyncedGroupInfo(zoneId);
    if (syncInfo) {
        var zones = []
        for (var i in syncInfo.members) {
            if (zoneId != syncInfo.members[i]) {
                const zoneObj = this._zones[syncInfo.members[i] - 1];
                await zoneObj.getState();
                this._pushAudioEvents([zoneObj]);
            }
        }
    }
  }

  pushRoomFavEvent(zone) {
    this._pushRoomFavEvents([zone]);
  }

  pushQueueEvent(zone) {
    this._pushQueueEvents([zone]);
  }

  _pushAudioEvents(zones) {

    const audioEvents = zones.map((zone) => {
      return this._getAudioState(zone);
    });

    const audioEventsMessage = JSON.stringify({
      audio_event: audioEvents,
    });

    this._wsConnections.forEach((connection) => {
      connection.send(audioEventsMessage);
    });
  }

  _pushAudioSyncEvents() {
    const syncGroups = this._master.getSyncGroups();

    var audioSyncEvent = []
    for (var i in syncGroups) {
        var players = []
        for (var j in syncGroups[i]) {
            players.push({ playerid: +syncGroups[i][j] })
        }
        audioSyncEvent.push({ group: +i + 1, players, masterVolume: 50});
    }

    const audioSyncEventsMessage = JSON.stringify({
      audio_sync_event: audioSyncEvent,
    });

    this._wsConnections.forEach((connection) => {
      connection.send(audioSyncEventsMessage);
    });
  }

  _pushFavoritesChangedEvent() {
    const favoritesChangedEventMessage = JSON.stringify({
      favoriteschanged_event: [],
    });

    this._wsConnections.forEach((connection) => {
      connection.send(favoritesChangedEventMessage);
    });
  }

  _pushInputsChangedEvent() {
    const inputsChangedEventMessage = JSON.stringify({
      lineinchanged_event: [],
    });

    this._wsConnections.forEach((connection) => {
      connection.send(inputsChangedEventMessage);
    });
  }

  _pushLibraryChangedEvent() {
    const libraryChangedEventMessage = JSON.stringify({
      rescan_event: [{status: 0}],
    });

    this._wsConnections.forEach((connection) => {
      connection.send(libraryChangedEventMessage);
    });
  }

  _pushScanStatusChangedEvent(status) {
      const message = JSON.stringify({
        rescan_event: [
           {
              status
           },
        ],
      });
      this._wsConnections.forEach((connection) => {
        connection.send(message);
      });
  }

  _pushReloadAppEvent() {
      const message = JSON.stringify({
        reloadmusicapp_event: [
           {

           },
        ],
      });
      this._wsConnections.forEach((connection) => {
        connection.send(message);
      });
  }

  _pushPlaylistsChangedEvent(playlistId, actionName, playlistName) {
     const playlistsChangedEventMessage = JSON.stringify({
       playlistchanged_event: [
         {
           cmd: 'lms',
           user: 'noUser',
           playlistid: this._encodeId(playlistId, BASE_PLAYLIST),
           action: actionName,
           name: playlistName
         },
       ],
     });

     this._wsConnections.forEach((connection) => {
       connection.send(playlistsChangedEventMessage);
     });
  }

  _pushRoomFavEvents(zones) {
    zones.forEach((zone) => {
      const message = JSON.stringify({
        roomfav_event: [
          {
            'playerid': this._zones.indexOf(zone) + 1,
            'playing slot': zone.getFavoriteId(),
          },
        ],
      });

      this._wsConnections.forEach((connection) => {
        connection.send(message);
      });
    });
  }

  _pushRoomFavChangedEvents(zones) {
    zones.forEach((zone) => {
      const message = JSON.stringify({
        roomfavchanged_event: [
          {
            playerid: this._zones.indexOf(zone) + 1,
          },
        ],
      });

      this._wsConnections.forEach((connection) => {
        connection.send(message);
      });
    });
  }

  _pushQueueEvents(zones) {
    zones.forEach((zone) => {
      const message = JSON.stringify({
        audio_queue_event: [
          {
            playerid: this._zones.indexOf(zone) + 1,
          },
        ],
      });

      this._wsConnections.forEach((connection) => {
        connection.send(message);
      });
    });
  }


  _initSse() {
    http
      .get(
        this._config.gateway + '/events',

        {
          headers: {'Accept': 'text/event-stream', 'Last-Event-ID': 0},
        },

        (res) => {
          if (res.statusCode !== 200) {
            res.on('data', () => {});
            return;
          }

          res.on('data', (chunk) => {
            chunk
              .toString()
              .split(/\n+/g)
              .forEach(this._sseHandler, this);
          });

          res.on('end', () => this._initSse());

          res.on('error', (err) => {
            console.error('[ERR!] Invalid events endpoint: ' + err.message);
          });
        },
      )
      .on('error', (err) => {
        console.error('[ERR!] Invalid events endpoint: ' + err.message);
      });
  }

  _sseHandler(url) {
    switch (true) {
      case /^(data:)\s*\/favorites\/\d+\s*$/.test(url): {
        const [, , position] = url.split('/');

        this._master.getFavoriteList().reset(+position);
        this._pushFavoritesChangedEvent();

        console.log('<-- [EVTS] Reset favorites');

        break;
      }

      case /^(data:)?\s*\/inputs\/\d+\s*$/.test(url): {
        const [, , position] = url.split('/');

        this._master.getInputList().reset(+position);
        this._pushInputsChangedEvent();

        console.log('<-- [EVTS] Reset inputs');

        break;
      }

      case /^(data:)?\s*\/library\/\d+\s*$/.test(url): {
        const [, , position] = url.split('/');

        this._master.getLibraryList().reset(+position);
        this._pushLibraryChangedEvent();
        console.log('<-- [EVTS] Reset library');

        break;
      }

      case /^(data:)?\s*\/playlists\/\d+\s*$/.test(url): {
        const [, , position] = url.split('/');

        this._master.getPlaylistList().reset(+position);
        this._pushPlaylistsChangedEvent();
        console.log('<-- [EVTS] Reset playlists');

        break;
      }

      case /^(data:)?\s*\/zone\/\d+\/favorites\/\d+\s*$/.test(url): {
        const [, , zoneId, , position] = url.split('/');
        const zone = this._zones[+zoneId - 1];

        zone.getFavoritesList().reset(+position);
        this._pushRoomFavChangedEvents([zone]);

        console.log('<-- [EVTS] Reset zone favorites');

        break;
      }

      case /^(data:)?\s*\/zone\/\d+\/state\s*$/.test(url): {
        const [, , zoneId] = url.split('/');
        const zone = this._zones[+zoneId - 1];

        zone.getState();
        // No need to push an event, getState does it automatically.

        console.log('<-- [EVTS] Reset zone favorites');

        break;
      }
    }
  }

  _handler(method, data) {
    if (method.startsWith('/'))
        method = method.slice(1);
    const index = method.indexOf('?');
    const url = index === -1 ? method : method.substr(0, index);
    const query = querystring.parse(method.substr(url.length + 1));

    switch (true) {
      case /(?:^|\/)audio\/cfg\/all(?:\/|$)/.test(url):
        return this._audioCfgAll(url);

      case /(?:^|\/)audio\/cfg\/equalizer\//.test(url):
        return this._audioCfgEqualizer(url);

      case /(?:^|\/)audio\/cfg\/favorites\/addpath\//.test(url):
        return this._audioCfgFavoritesAddPath(url);

      case /(?:^|\/)audio\/cfg\/favorites\/delete\//.test(url):
        return this._audioCfgFavoritesDelete(url);

      case /(?:^|\/)audio\/cfg\/getfavorites\//.test(url):
        return this._audioCfgGetFavorites(url);

      case /(?:^|\/)audio\/cfg\/getinputs(?:\/|$)/.test(url):
        return this._audioCfgGetInputs(url);

      case /(?:^|\/)audio\/cfg\/getkey(?:\/|$)/.test(url):
        return this._audioCfgGetKey(url);

      case /(?:^|\/)audio\/cfg\/getmediafolder(?:\/|$)/.test(url):
        return this._audioCfgGetMediaFolder(url, []);

      case /(?:^|\/)audio\/cfg\/get(?:paired)?master(?:\/|$)/.test(url):
        return this._audioCfgGetMaster(url);

      case /(?:^|\/)audio\/cfg\/getplayersdetails(?:\/|$)/.test(url):
        return this._audioCfgGetPlayersDetails(url);

      case /(?:^|\/)audio\/cfg\/getplaylists2\/lms(?:\/|$)/.test(url):
        return this._audioCfgGetPlaylists(url);

      case /(?:^|\/)audio\/cfg\/getradios(?:\/|$)/.test(url):
        return this._audioCfgGetRadios(url);

      case /(?:^|\/)audio\/cfg\/getroomfavs\//.test(url):
        return this._audioCfgGetRoomFavs(url);

      case /(?:^|\/)audio\/cfg\/get(?:available)?services(?:\/|$)/.test(url):
        return this._audioCfgGetServices(url);

      case /(?:^|\/)audio\/cfg\/getservicefolder(?:\/|$)/.test(url):
        return this._audioCfgGetServiceFolder(url);

      case /(?:^|\/)audio\/cfg\/getsyncedplayers(?:\/|$)/.test(url):
        return this._audioCfgGetSyncedPlayers(url);

      case /(?:^|\/)audio\/cfg\/globalsearch\/describe(?:\/|$)/.test(url):
        return this._audioCfgGlobalSearchDescribe(url);

      case /(?:^|\/)audio\/cfg\/globalsearch\//.test(url):
        return this._audioCfgGlobalSearch(url);

      case /(?:^|\/)audio\/cfg\/search\//.test(url):
        return this._audioCfgSearch(url);

      case /(?:^|\/)audio\/cfg\/iamaminiserver(?:done)?\//.test(url):
        return this._audioCfgIAmAMiniserver(url);

      case /(?:^|\/)audio\/cfg\/miniserverport\//.test(url):
        return this._audioCfgMiniserverPort(url);

      case /(?:^|\/)audio\/cfg\/input\/[^\/]+\/rename\//.test(url):
        return this._audioCfgInputRename(url);

      case /(?:^|\/)audio\/cfg\/input\/[^\/]+\/type\//.test(url):
        return this._audioCfgInputType(url);

      case /(?:^|\/)audio\/cfg\/mac(?:\/|$)/.test(url):
        return this._audioCfgMac(url);

      case /(?:^|\/)audio\/cfg\/playlist\/create(?:\/|$)/.test(url):
        return this._audioCfgPlaylistCreate(url);

      case /(?:^|\/)audio\/cfg\/playlist\/deletelist\//.test(url):
        return this._audioCfgPlaylistDeleteList(url);

      case /(?:^|\/)audio\/cfg\/scanstatus(?:\/|$)/.test(url):
        return this._audioCfgScanStatus(url);

      case /(?:^|\/)audio\/cfg\/rescan(?:\/|$)/.test(url):
        return this._audioCfgRescan(url);

      case /(?:^|\/)audio\/cfg\/storage\/add(?:\/|$)/.test(url):
        return this._audioCfgStorageAdd(url);

      case /(?:^|\/)audio\/cfg\/upload(?:\/|$)/.test(url):
        return this._audioUpload(url, data);

      case /(?:^|\/)audio\/grouped\/playuploadedfile(?:\/|$)/.test(url):
        return this._playUploadedFile(url);

      case /(?:^|\/)audio\/cfg\/defaultvolume(?:\/|$)/.test(url):
        return this._audioCfgDefaultVolume(url);

      case /(?:^|\/)audio\/cfg\/maxvolume(?:\/|$)/.test(url):
        return this._audioCfgMaxVolume(url);

      case /(?:^|\/)audio\/cfg\/eventvolumes(?:\/|$)/.test(url):
        return this._audioCfgEventVolumes(url);

      case /(?:^|\/)audio\/\d+\/(?:(fire)?alarm|bell|wecker)(?:\/|$)/.test(url):
        return this._audioAlarm(url);

      case /(?:^|\/)audio\/\d+\/favoriteplay(?:\/|$)/.test(url):
        return this._audioFavoritePlay(url, []);

      case /(?:^|\/)audio\/\d+\/getqueue(?:\/|$)/.test(url):
        return this._audioGetQueue(url, []);

      case /(?:^|\/)audio\/\d+\/identifysource(?:\/|$)/.test(url):
        return this._audioIdentifySource(url);

      case /(?:^|\/)audio\/\d+\/library\/play(?:\/|$)/.test(url):
        return this._audioLibraryPlay(url);

      case /(?:^|\/)audio\/\d+\/linein/.test(url):
        return this._audioLineIn(url);

      case /(?:^|\/)audio\/\d+\/off/.test(url):
        return this._audioOff(url);

      case /(?:^|\/)audio\/\d+\/on/.test(url):
        return this._audioOn(url);

      case /(?:^|\/)audio\/\d+\/sleep\/\d+(?:\/|$)/.test(url):
        return this._audioSleep(url);

      case /(?:^|\/)audio\/\d+\/pause(?:\/|$)/.test(url):
        return this._audioPause(url);

      case /(?:^|\/)audio\/\d+\/stop(?:\/|$)/.test(url):
        return this._audioStop(url);

      case /(?:^|\/)audio\/\d+\/(?:play|resume)(?:\/|$)/.test(url):
        return this._audioPlay(url);

      case /(?:^|\/)audio\/\d+\/playurl\//.test(url):
        return this._audioPlayUrl(url);

      case /(?:^|\/)audio\/\d+\/playlist\//.test(url):
        return this._audioPlaylist(url);

      case /(?:^|\/)audio\/\d+\/position\/\d+(?:\/|$)/.test(url):
        return this._audioPosition(url);

      case /(?:^|\/)audio\/\d+\/queueminus(?:\/|$)/.test(url):
        return this._audioQueueMinus(url);

      case /(?:^|\/)audio\/\d+\/queueplus(?:\/|$)/.test(url):
        return this._audioQueuePlus(url);

      case /(?:^|\/)audio\/\d+\/queue\/\d+(\/|$)/.test(url):
        return this._audioQueueIndex(url);

      case /(?:^|\/)audio\/\d+\/queueremove\/\d+(\/|$)/.test(url):
        return this._audioQueueDelete(url);

      case /(?:^|\/)audio\/\d+\/queue\/clear(\/|$)/.test(url):
        return this._audioQueueClear(url);

      case /(?:^|\/)audio\/\d+\/queuemove\/\d+\/\d+(\/|$)/.test(url):
        return this._audioQueueMove(url);

      case /(?:^|\/)audio\/\d+\/queueadd(\/|$)/.test(url):
        return this._audioQueueAdd(url);

      case /(?:^|\/)audio\/\d+\/queueinsert(\/|$)/.test(url):
        return this._audioQueueInsert(url);

      case /(?:^|\/)audio\/\d+\/repeat\/\d+(?:\/|$)/.test(url):
        return this._audioRepeat(url);

      case /(?:^|\/)audio\/\d+\/roomfav\/delete\/\d+(\/|$)/.test(url):
        return this._audioRoomFavDelete(url);

      case /(?:^|\/)audio\/\d+\/roomfav\/play\/\d+(?:\/|$)/.test(url):
        return this._audioRoomFavPlay(url);

      case /(?:^|\/)audio\/\d+\/roomfav\/plus(?:\/|$)/.test(url):
        return this._audioRoomFavPlus(url);

      case /(?:^|\/)audio\/\d+\/roomfav\/savepath\/\d+\//.test(url):
      case /(?:^|\/)audio\/\d+\/roomfav\/saveid\/\d+\//.test(url):
        return this._audioRoomFavSavePath(url);

      case /(?:^|\/)audio\/\d+\/roomfav\/saveexternalid\/\d+\//.test(url):
        return this._audioRoomFavSaveExternalId(url);

      case /(?:^|\/)audio\/\d+\/serviceplay\//.test(url):
        return this._audioServicePlay(url);

      case /(?:^|\/)audio\/\d+\/serviceplayinsert\//.test(url):
        return this._audioServicePlayInsert(url);

      case /(?:^|\/)audio\/\d+\/serviceplayadd\//.test(url):
        return this._audioServicePlayAdd(url);

      case /(?:^|\/)audio\/\d+\/shuffle\/\d+(?:\/|$)/.test(url):
        return this._audioShuffle(url);

      case /(?:^|\/)audio\/\d+\/sync\/\d+(?:\/|$)/.test(url):
        return this._audioSync(url);

      case /(?:^|\/)audio\/\d+\/unsync(?:\/|$)/.test(url):
        return this._audioUnSync(url);

      case /(?:^|\/)audio\/cfg\/unsyncmulti(?:\/|$)/.test(url):
        return this._audioUnSyncMulti(url);

      case /(?:^|\/)audio\/\d+\/volume\/[+-]?\d+(?:\/|$)/.test(url):
        return this._audioVolume(url);

      default:
        return this._unknownCommand(url);
    }
  }

  _audioCfgAll(url) {
    return this._response(url, 'configall', [
      {
        airplay: false,
        dns: '8.8.8.8',
        errortts: false,
        gateway: '0.0.0.0',
        hostname: 'loxberry-music-server-' + this._config.port,
        ip: '0.255.255.255',
        language: 'en',
        lastconfig: '',
        macaddress: this._mac(),
        mask: '255.255.255.255',
        master: true,
        maxplayers: this._config.players,
        ntp: '0.europe.pool.ntp.org',
        upnplicences: 0,
        usetrigger: false,
        players: this._zones.map((zone, i) => ({
          playerid: i + 1,
          players: [{playerid: i + 1}],
          clienttype: 0,
          default_volume: zone.getDefaultVolume(),
          enabled: true,
          internalname: 'zone-' + (i + 1),
          max_volume: zone.getMaxVolume(),
          volume: zone.getVolume(),
          name: 'Zone ' + (i + 1),
          upnpmode: 0,
          upnppredelay: 0,
        })),
      },
    ]);
  }

  async _audioCfgEqualizer(url) {
    const [, , , zoneId, config] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const bands = config && config.split(',').map(Number);
    let value;

    if (+zoneId <= 0) {
      value = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    } else if (config === undefined) {
      value = await zone.getEqualizer();
    } else {
      value = (await zone.equalizer(bands)) || bands;
    }

    // The Loxone Miniserver expects floats in the response, even when the
    // number is an integer. JSON.stringify can't generate this format so we
    // have to manually stringify it.
    return `
      {
        "equalizer_result": [
          {
            "playerid": ${+zoneId},

            "equalizer": {
              ${value.map((band, i) => `"B${i}": ${band.toFixed(1)}`).join(',')}
            }
          }
        ],
        "command": "${url}"
      }
    `;
  }

  async _audioCfgFavoritesAddPath(url) {
    const [name, id] = url.split('/').slice(-2);
    const playlists = this._master.getFavoriteList();
    const [decodedId] = this._decodeId(id);

    const {total} = await playlists.get(undefined, 0, 0);

    await this._master.getFavoriteList().insert(total, {
      id: decodedId,
      title: decodeURIComponent(name),
      image: this._imageStore[decodedId],
    });

    return this._emptyCommand(url, []);
  }

  async _audioCfgFavoritesDelete(url) {
    const [name, id] = url.split('/').slice(-2);
    const [decodedId] = this._decodeId(id);

    const {total, items} = await this._master.getFavoriteList().get(undefined, 0, 50);

    console.log("ID: ", decodedId)

    var foundIndex = undefined
    for (var i in items) {
        if (items[i].id == decodedId) {
            foundIndex = i;
            break;
        }
    }
    if (!foundIndex) {
        console.log("Coudln't find the requested favorite");
        return this._emptyCommand(url, []);
    }

    await this._master.getFavoriteList().delete(foundIndex, 1);

    return this._emptyCommand(url, []);
  }

  async _audioCfgGetFavorites(url) {
    const [, , , start, length] = url.split('/');
    const {total, items} = await this._master.getFavoriteList().get(undefined, +start, +length);

    return this._response(url, 'getfavorites', [
      {
        totalitems: total,
        start: +start,
        items: items.map(this._convert(5, BASE_FAVORITE_GLOBAL, +start)),
      },
    ]);
  }

  async _audioCfgGetInputs(url) {
    const {total, items} = await this._master.getInputList().get(undefined, 0, +Infinity);

    const icons = Object.assign(Object.create(null), {
      'line-in': 0,
      'cd-player': 1,
      'computer': 2,
      'i-mac': 3,
      'i-pod': 4,
      'mobile': 5,
      'radio': 6,
      'tv': 7,
      'turntable': 8,
    });

    return this._response(
      url,
      'getinputs',
      items.map((item, i) => ({
        id: this._encodeId(item.id, BASE_INPUT + i),
        name: item.title,
        coverurl: this._imageUrl(item.image in icons ? undefined : item.image),
        icontype: icons[item.image] || 0,
        enabled: true,
      })),
    );
  }

  _audioCfgGetKey(url) {
    const data = [{pubkey: this._rsaKey.keyPair.n.toString(16), exp: this._rsaKey.keyPair.e }];
    return this._emptyCommand(url, data);
  }

  async _audioCfgGetMediaFolder(url) {
    const [, , , requestId, start, length] = url.split('/');

    let rootItem = undefined;
    if (requestId != 0) {
        const [decodedId] = this._decodeId(requestId);
        rootItem = decodedId;
    }

    const {total, items} = await this._master.getLibraryList().get(rootItem, +start, +length);

    return this._response(url, 'getmediafolder', [
      {
        id: requestId,
        totalitems: total,
        start: +start,
        items: items.map(this._convert(2, BASE_LIBRARY, +start)),
      },
    ]);
  }

  _audioCfgGetMaster(url) {
    return JSON.stringify(url, url.split('/').pop(), null);
  }

  _audioCfgGetPlayersDetails(url) {
    const audioStates = this._zones.map((zone, i) => {
      return this._getAudioState(zone);
    });

    return this._response(url, 'getplayersdetails', audioStates);
  }

  async _audioCfgGetPlaylists(url) {
    const [, , , , , id, start, length] = url.split('/');
    let rootItem = undefined;
    if (id != 0) {
        const [decodedId] = this._decodeId(id);
        rootItem = decodedId;
    }

    const {total, items} = await this._master.getPlaylistList().get(rootItem, +start, +length);

    return this._response(url, 'getplaylists2', [
      {
        id: id,
        totalitems: total,
        start: +start,
        items: items.map(this._convert(11, BASE_PLAYLIST)),
      },
    ]);
  }

  async _audioCfgGetRadios(url) {
    const {total, items} = await this._master.getRadioList().get(undefined, 0, 50);

    return this._response(url, 'getradios', items);
  }

  async _audioCfgGetRoomFavs(url) {
    const [, , , zoneId, start, length] = url.split('/');

    if (+zoneId > 0) {
      const zone = this._zones[+zoneId - 1];
      const {total, items} = await zone.getFavoritesList().get(undefined, +start, +length);

      const mappedItems = items
        .map(this._convert(4, BASE_FAVORITE_ZONE, +start))
        .filter((item) => !item.isAnEmptySlot);

      return this._response(url, 'getroomfavs', [
        {
          id: +zoneId,
          totalitems: mappedItems.length,
          start: +start,
          items: mappedItems,
        },
      ]);
    }

    return this._response(url, 'getroomfavs', []);
  }

  async _audioCfgGetServices(url) {
    const {total, items} = await this._master.getServiceList().get(undefined, 0, 50);

    return this._emptyCommand(url, items);
  }

  async _audioFavoritePlay(url) {
    const [, zoneId, , id] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId, favoriteId] = this._decodeId(id);

    await zone.play(decodedId, favoriteId);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioCfgGetServiceFolder(url) {
    let [, , , service, user, requestId, start, length] = url.split('/');

    let rootItem = service

    if (requestId != 0 && requestId != 'start') {
        const [decodedId] = this._decodeId(requestId);
        rootItem = rootItem + '%%%' + decodedId
    }

    const {total, items} = await this._master.getServiceFolderList().get(rootItem, start, length);

    return this._response(url, 'getservicefolder/' + service + '/' + user, [
      {
        id: requestId,
        totalitems: total,
        start: +start,
        items: items.map(this._convert(2, BASE_SERVICE, +start)),
      },
    ]);

    return this._response(url, 'getservicefolder/' + service + '/' + user, items);
  }

  _audioCfgGetSyncedPlayers(url) {
    return this._emptyCommand(url, []);
  }

  async _audioCfgGlobalSearchDescribe(url) {
    return this._response(url, 'globalsearch', await this._master.getSearchableTypes());
  }

  async _audioCfgGlobalSearch(url) {
    const [, , , inputString, search] = url.split('/');

    const splitted = inputString.split('|');
    for (var i in splitted) {
        const [typeUser, catNumbers] = splitted[i].split(':');
        let cats = catNumbers.split(',');
        let type = typeUser.split('@')[0];

        var search_result = {};
        for (var j in cats) {
            const [category, length] = cats[j].split('#');
            let response = await this._master.search(type, category, search, 0, length);
            response.items = response.items.map(this._convert(2, BASE_SERVICE)),
            response.caption = response.name;
            if (response.count > length) {
                response.link = ['audio/cfg/search', type, category, search, 0, 50].join('/');
            }

            search_result[category] = response;
        }

        var search_response = {
            globalsearch_result: type == "spotify" ? { result: search_result } : search_result,
            type: type,
            command: url,
        };

        // Each search needs to send its own result

        this._wsConnections.forEach((connection) => {
          connection.send(JSON.stringify(search_response, null, 2));
        });
    }

    return this._emptyCommand(url, []);
  }

  async _audioCfgSearch(url) {
    const [, , , type, category, search, start, length] = url.split('/');

    const data = await this._master.search(type, category, search, start, length);

    return this._response(url, 'search/', [
      {
        results: [
            {
                totalitems: data.count,
                start: +start,
                items: data.items.map(this._convert(2, BASE_SERVICE, +start)),
            }
        ],
      }
    ]);
  }

  _audioCfgIAmAMiniserver(url) {
    this._miniserverIp = url.split('/').pop();

    return this._response(url, 'iamamusicserver', {
      iamamusicserver: 'i love miniservers!',
    });
  }

  _audioCfgMiniserverPort(url) {
    this._miniserverPort = url.split('/').pop();

    return this._emptyCommand(url, []);
  }

  _audioCfgMac(url) {
    return this._response(url, 'mac', [
      {
        macaddress: this._mac(),
      },
    ]);
  }

  async _audioCfgInputRename(url) {
    const [, , , id, , title] = url.split('/');
    const [decodedId, favoriteId] = this._decodeId(id);
    const position = favoriteId % BASE_DELTA;
    const item = (await this._master.getInputList().get(undefined, position, 1)).items[0];

    item.title = decodeURIComponent(title);
    await this._master.getInputList().replace(position, [item]);

    return this._emptyCommand(url, []);
  }

  async _audioCfgInputType(url) {
    const [, , , id, , icon] = url.split('/');
    const [decodedId, favoriteId] = this._decodeId(id);
    const position = favoriteId % BASE_DELTA;
    const item = (await this._master.getInputList().get(undefined, position, 1)).items[0];

    const icons = [
      `line-in`,
      `cd-player`,
      `computer`,
      `i-mac`,
      `i-pod`,
      `mobile`,
      `radio`,
      `tv`,
      `turntable`,
    ];

    item.image = icons[icon];
    await this._master.getInputList().replace(position, [item]);

    return this._emptyCommand(url, []);
  }

  async _audioCfgPlaylistCreate(url) {
    const title = decodeURIComponent(url.split('/').pop());
    const playlists = this._master.getPlaylistList();

    const {total} = await playlists.get(undefined, 0, 0);

    await this._master.getPlaylistList().insert(total, {
      id: null,
      title,
      image: null,
    });

    return this._emptyCommand(url, []);
  }

  async _audioCfgPlaylistDeleteList(url) {
    const [name, id] = url.split('/').slice(-2);
    const [decodedId] = this._decodeId(id);

    await this._master.getPlaylistList().delete(decodedId, 1);

    return this._emptyCommand(url, [{items: []}]);
  }

  async _audioCfgScanStatus(url) {
    let status = await this._master.scanStatus();

    return this._emptyCommand(url, [{scanning: +status}]);
  }

  async _audioCfgRescan(url) {
    await this._master.rescanLibrary();

    return this._emptyCommand(url, []);
  }

  async _audioCfgStorageAdd(url) {
    const config = url.split('/').pop();
    const decodedConfig = this._decodeId(config);

    // used when decrypting doesn't work
    // Invalid creds
    var configerror = 12;
    try {
        if (decodedConfig.password)
            decodedConfig.password = this._rsaKey.decrypt(decodedConfig.password).toString();
        configerror = await this._master.addNetworkShare(decodedConfig);
    } catch (err) {
        console.error("[ERR!] Couldn't decrypt password: " + err.message);
    }

    console.log(configerror)

    return this._emptyCommand(url, { configerror });
  }

  async _audioCfgDefaultVolume(url) {
    const [, , , zoneId, volume] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    if (volume) {
      await zone.defaultVolume(+volume);
    }

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioCfgMaxVolume(url) {
    const [, , , zoneId, volume] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    if (volume) {
      await zone.maxVolume(+volume);
    }

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioCfgEventVolumes(url) {
    const [, , , zoneId, volumeString] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    //TODO unclear what to do here, as the values are saved on the miniserver
    //     and we don't know how to get the inital values.

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioAlarm(url) {
    const [, zoneId, type, volume] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    const alarms = {
      alarm: 'general',
      bell: 'bell',
      firealarm: 'fire',
      wecker: 'clock',
    };

    await zone.alarm(
      alarms[type],
      volume === undefined ? zone.getVolume() : +volume,
    );

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioGetQueue(url) {
    const [, zoneId, , start, length] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    if (+zoneId > 0) {
      const zone = this._zones[+zoneId - 1];
      let {total, items} = await zone.getQueueList().get(undefined, +start, +length);

      if (total === 0) {
        items = +start === 0 ? [zone.getTrack()] : [];
        total = 1;
      }

      return this._response(url, 'getqueue', [
        {
          id: +zoneId,
          totalitems: total,
          start: +start,
          items: items.map(this._convert(2, 0, +start)),
        },
      ]);
    }

    return this._response(url, 'getqueue', []);
  }

  async _audioIdentifySource(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    return this._response(url, 'identifysource', [this._getAudioState(zone)]);
  }

  async _audioLibraryPlay(url) {
    const [, zoneId, , , id] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId, favoriteId] = this._decodeId(id);

    await zone.play(decodedId, favoriteId);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioLineIn(url) {
    const [, zoneId, id] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId, favoriteId] = this._decodeId(id.replace(/^linein/, ''));

    await zone.play(decodedId, favoriteId);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioOff(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.power('off');

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioOn(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.power('on');

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioSleep(url) {
    const [, zoneId, ,duration] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.sleep(+duration);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioPause(url) {
    const [, zoneId, , volume] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.pause();

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioStop(url) {
    const [, zoneId, , volume] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.stop();

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioPlay(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    if (zone.getMode() === 'stop') {
      await zone.play(null, 0);
    } else {
      await zone.resume();
    }

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioPlayUrl(url) {
    const [, zoneId, ,id] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId, favoriteId] = this._decodeId(id);

    await zone.play(decodedId, favoriteId);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioPlaylist(url) {
    const [, zoneId, , , id] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId, favoriteId] = this._decodeId(id);

    await zone.play(decodedId, favoriteId);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioPosition(url) {
    const [, zoneId, , time] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.time(+time * 1000);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  _audioQueueMinus(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    if (zone.getTime() < 3000) {
      zone.previous();
    } else {
      zone.time(0);
    }

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  _audioQueuePlus(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    zone.next();

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioQueueIndex(url) {
    const [, zoneId, , index] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.setCurrentIndex(index);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioQueueDelete(url) {
    const [, zoneId, , position] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.getQueueList().delete(+position, 1);
    this._pushQueueEvents([zone]);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioQueueClear(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.getQueueList().clear();
    this._pushQueueEvents([zone]);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioQueueMove(url) {
    const [, zoneId, , position, destination] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.getQueueList().move(+position, +destination);
    this._pushQueueEvents([zone]);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioQueueAdd(url) {
    const [, zoneId, , id] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId] = this._decodeId(id);

    const {total} = await zone.getQueueList().get(undefined, 0, 0);

    await zone.getQueueList().insert(total, {
      id: decodedId,
      title: null,
      image: null,
    });

    return this._emptyCommand(url, []);
  }

  async _audioQueueInsert(url) {
    const [, zoneId, , id] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId] = this._decodeId(id);

    const qindex = zone.getTrack().qindex;
    if (!qindex)
        qindex = 0

    await zone.getQueueList().insert(qindex + 1, {
      id: decodedId,
      title: null,
      image: null,
    });

    return this._emptyCommand(url, []);
  }

  _audioRepeat(url) {
    const [, zoneId, , repeatMode] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const repeatModes = {0: 0, 1: 2, 3: 1};

    zone.repeat(repeatModes[repeatMode]);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioRoomFavDelete(url) {
    const [, zoneId, , , position, id, title] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.getFavoritesList().delete(+position - 1, 1);
    this._pushRoomFavChangedEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavPlay(url) {
    const [, zoneId, , , position] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    const favorites = await zone.getFavoritesList().get(undefined, 0, 50);
    const id = favorites.items[+position - 1].id;

    await zone.play(id, BASE_FAVORITE_ZONE + (+position - 1));

    this._pushRoomFavEvents([zone]);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioRoomFavPlus(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const favoriteId = zone.getFavoriteId();
    const favorites = await zone.getFavoritesList().get(undefined, 0, 8);

    let position =
      BASE_DELTA * Math.floor(favoriteId / BASE_DELTA) === BASE_FAVORITE_ZONE
        ? (favoriteId % BASE_FAVORITE_ZONE) + 1
        : 0;

    for (; position < 16; position++) {
      if (favorites.items[position % 8]) {
        position = position % 8;
        break;
      }
    }

    const id = favorites.items[position].id;

    await zone.play(id, BASE_FAVORITE_ZONE + position);

    this._pushRoomFavEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavSavePath(url) {
    const [, zoneId, , , position, id, title] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId] = this._decodeId(id);

    const item = {
      id: decodedId,
      title,
      image: this._imageStore[decodedId],
    };

    await zone.getFavoritesList().replace(+position - 1, item);
    this._pushRoomFavChangedEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavSaveExternalId(url) {
    const [, zoneId, , , position, ,id, title] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId] = this._decodeId(id);

    const item = {
      id: decodedId,
      title,
      image: this._imageStore[decodedId],
    };

    await zone.getFavoritesList().replace(+position - 1, item);
    this._pushRoomFavChangedEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioServicePlay(url) {
    const [, zoneId, , , , id] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId, favoriteId] = this._decodeId(id);

    await zone.play(decodedId, favoriteId);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioServicePlayInsert(url) {
    const [, zoneId, , , , id] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId] = this._decodeId(id);

    const qindex = zone.getTrack().qindex;
    if (!qindex)
        qindex = 0

    await zone.getQueueList().insert(qindex + 1, {
      id: decodedId,
      title: null,
      image: null,
    });

    return this._emptyCommand(url, []);
  }

  async _audioServicePlayAdd(url) {
    const [, zoneId, , , , id] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId] = this._decodeId(id);

    const {total} = await zone.getQueueList().get(undefined, 0, 0);

    await zone.getQueueList().insert(total, {
      id: decodedId,
      title: null,
      image: null,
    });

    return this._emptyCommand(url, []);
  }

  _audioShuffle(url) {
    const [, zoneId, , shuffle] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    zone.shuffle(+shuffle);

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioSync(url) {
    const [, zoneId, , ...zones] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    zone.sync(zones);

    return this._emptyCommand(url, []);
  }

  async _audioUnSync(url) {
    const [, zoneId,] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    zone.unSync();

    return this._emptyCommand(url, []);
  }

  async _audioUnSyncMulti(url) {
    const [, , , ...zones] = url.split('/');

    console.log(url.split('/'), zones)

    for (var i in zones) {
        const zone = this._zones[+zones[i] - 1];
        zone.unSync();
    }

    return this._emptyCommand(url, []);
  }

  async _audioVolume(url) {
    const [, zoneId, , volume] = url.split('/');
    const zone = this._zones[+zoneId - 1];
	//T5 Control
	//If player state is stop/pause the player will be set to play/resumed without changing the volume.
	//If player state is play the volume will be changed.
	if (zone.getMode() === 'stop') {
      await zone.play(null, 0);
    } else if (zone.getMode() === 'pause') {
	  await zone.resume();
	} else {
	  if (/^[+-]/.test(volume)) {
      await zone.volume(zone.getVolume() + +volume);
    } else {
      await zone.volume(+volume);
    }
    }

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioUpload(url, data) {
    const [, , , , , filename] = url.split('/');

    fs.writeFileSync(config.uploadPath + '/' + filename, data);

    return this._emptyCommand(url, []);
  }

  async _playUploadedFile(url) {
    const [, , , filename, ...zones] = url.split('/');

    this._master.playUploadedFile(config.uploadPlaybackPath + '/' + filename, zones);

    return this._emptyCommand(url, []);
  }

  _emptyCommand(url, response) {
    const parts = url.split('/');

    for (let i = parts.length; i--; ) {
      if (/^[a-z]/.test(parts[i])) {
        return this._response(url, parts[i], response);
      }
    }
  }

  _unknownCommand(url) {
    console.warn('[HTWS] Unknown command: ' + url);

    return this._emptyCommand(url, null);
  }

  _getAudioState(zone) {
    const repeatModes = {0: 0, 2: 1, 1: 3};
    const playerId = this._zones.indexOf(zone) + 1;

    const track = zone.getTrack();
    const mode = zone.getMode();
    const syncInfo = this._getSyncedGroupInfo(playerId);

    // It is possible to also send a groupid here to let the app know whether this event is
    // for a whole group.
    // This doesn't work well with the custom power management LMS supports and doesn't work well
    // with the way we push our changes and do the syncing.
    return {
      playerid: playerId,
      album: track.album,
      artist: track.artist,
      audiopath: this._encodeId(track.id, 0),
      audiotype: 2,
      coverurl: this._imageUrl(track.image || ''),
      duration: mode === 'buffer' ? 0 : Math.ceil(track.duration / 1000),
      mode: mode === 'buffer' ? 'play' : mode,
      players: [{playerid: playerId}],
      plrepeat: repeatModes[zone.getRepeat()],
      plshuffle: zone.getShuffle(),
      power: zone.getPower(),
      station: track.station,
      time: zone.getTime() / 1000,
      qindex: track.qindex ? track.qindex : 0,
      title: track.title,
      volume: zone.getVolume(),
      default_volume: zone.getDefaultVolume(),
      max_volume: zone.getMaxVolume(),
    };
  }

  _getSyncedGroupInfo(zoneId) {
     const syncGroups = this._master.getSyncGroups();

     var audioSyncEvent = []
     for (var i in syncGroups) {
         if (syncGroups[i].includes(zoneId)) {
             return {
                groupid: i + 1,
                master: syncGroups[i][0],
                members: syncGroups[i],
             }
         }
     }
  }

  _convert(type, base, start) {
    return (item, i) => {
      if (!item) {
        return {
          type,
          slot: +start + i + 1,
          qindex: +start + i + 1,
          isAnEmptySlot: true,
          name: '',
        };
      }

      this._imageStore[item.id] = item.image;
      type = item.type ? item.type : type
      let newBase = base
      if (start != undefined)
            newBase += i;

      return {
        type,
        slot: start + i + 1,
        audiopath: this._encodeId(item.id, newBase),
        coverurl: this._imageUrl(item.image || undefined),
        id: this._encodeId(item.id, newBase),
        name: item.name ? item.name : "",
        title: item.title ? item.title : "",
        artist: item.artist ? item.artist : "",
        album: item.album ? item.album : "",
        station: item.station ? item.station : "",
      };
    };
  }

  _encodeId(data, offset) {
    const table = {
      '+': '-',
      '/': '_',
      '=': '',
    };

    if (typeof data !== 'string' && typeof data !== 'number') {
      const id = JSON.stringify(data);

      throw new Error(
        'Invalid id: <' + id + '>, only strings and numbers are allowed',
      );
    }

    return Buffer.from(JSON.stringify([data, offset]))
      .toString('base64')
      .replace(/[+/=]/g, (str) => table[str]);
  }

  _decodeId(data) {
    const table = {
      '-': '+',
      '_': '/',
    };

    return JSON.parse(
      Buffer.from(
        data.replace(/[-_]/g, (str) => table[str]),
        'base64',
      ),
    );
  }

  _response(url, name, result) {
    const message = {
      [name + '_result']: result,
      command: url,
    };

    return JSON.stringify(message, null, 2);
  }

  _mac() {
    if (config.macAddress != undefined && config.macAddress != "") {
        return config.macAddress;
    }

    const portAsMacAddress = (this._config.port / 256)
      .toString(16)
      .replace('.', ':')
      .padStart(5, '0');

    return '50:4f:94:ff:' + portAsMacAddress;
  }

  _imageUrl(url) {
    if (!url || !config.cors_port)
        return url;
    return 'http://' + this._hostIp + ':' + config.cors_port + '/' + url;
  }
};
