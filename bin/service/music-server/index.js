'use strict';

const http = require('http');
const cors_proxy = require('cors-anywhere');
const querystring = require('querystring');
const websocket = require('websocket');
const fs = require('fs');
const os = require('os');
const NodeRSA = require('node-rsa');
const debug = require('debug');
const lcApp = debug('MSG');

const config = JSON.parse(fs.readFileSync("config.json"));

const MusicMaster = require(config.plugin == "lms" ? './lms/music-master' : './music-master');
const MusicZone = require(config.plugin == "lms" ? './lms/music-zone' : './music-zone');

const Log = require("./log");
const console = new Log;

const MSClient = require("./ms-client")

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
    this._lc = lcApp;
    this._lcWSCK = lcApp.extend("WSCK");
    this._lcHTTP = lcApp.extend("HTTP");
    this._lcEVNT = lcApp.extend("EVNT");
    // setup the default logging categories
    if (!process.env.DEBUG)
        debug.enable('MSG:WSCK,MSG:HTTP,MSG:EVNT');

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
            console.error(this._lc, "Private Key: " + config.privateKey + " doesn't exist!")
        if (!fs.existsSync(config.publicKey))
            console.error(this._lc, "Public Key: " + config.publicKey + " doesn't exist!")

        this._rsaKey.importKey(fs.readFileSync(config.privateKey), "private");
        this._rsaKey.importKey(fs.readFileSync(config.publicKey), "public");
    } else {
        this._rsaKey = new NodeRSA({b: 1024});
    }
    this._rsaKey.setOptions({encryptionScheme: 'pkcs1'});


    for (let i = 0; i < config.zones; i++) {
      zones[i] = new MusicZone(this, i + 1, this);
    }

    this._master = new MusicMaster(this);
  }

  loggingCategory() {
    return this._lc;
  }

  async start() {
    if (this._httpServer || this._wsServer || this._dgramServer) {
      throw new Error('Music server already started');
    }

    const httpServer = http.createServer(async (req, res) => {
      console.log(this._lcHTTP, 'RECV:' + req.url);

      if (req.method === "OPTIONS") {
           res.writeHead(200, headers);
           res.end();
           return;
      }

      const chunks = [];

      // Handler for local icons
      if (req.url.startsWith("/icon")) {
         var reqpath = file = req.url.toString().split('?')[0];
         var file = '.' + reqpath;
         var s = fs.createReadStream(file);
         s.on('open', function () {
             res.setHeader('Content-Type', "image/svg+xml");
             s.pipe(res);
         });
         s.on('error', function () {
             res.setHeader('Content-Type', 'text/plain');
             res.statusCode = 404;
             res.end('Not found');
         });
         return;
      }

      try {
        req.on('data', (chunk) => {
            chunks.push(chunk);
        });
        req.on('end', async () => {
            const data = Buffer.concat(chunks);
            res.writeHead(200, headers);
            const response = await this._handler(req.url, data);
            console.log(this._lcHTTP, 'RESP:', JSON.stringify(JSON.parse(response)));
            res.end(response);
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
        console.log(this._lcWSCK, 'RECV:' + message.utf8Data);

        if (message.type !== 'utf8') {
          throw new Error('Unknown message type: ' + message.type);
        }

        const response = await this._handler(message.utf8Data);
        console.log(this._lcWSCK, 'RESP:', JSON.stringify(JSON.parse(response)));
        connection.sendUTF(response);
      });

      connection.on('close', () => {
        this._wsConnections.delete(connection);
      });

      connection.send(config.msApi); //1.4.10.06 | ~API:1.6~ 2.3.9.1 | ~API:1.6~

      // All those Events are send when a new client connects
      // E.g. opening the App, but also when switching back to the
      // app which was just minimized
      this._pushAudioEvents(this._zones);
      this._pushAudioSyncEvents();

      if (!this._msClients || !this._msClients[0].isSocketOpen()) {
        this.connectToMiniserver();
      }
    });

    httpServer.listen(this._config.port);
    if (config.cors_port)
        cors_proxy.createServer().listen(config.cors_port)

    this._initSse();

    this._httpServer = httpServer;
    this._wsServer = wsServer;
  }

  async connectToMiniserver() {
    this._msClients = [];
    for (var key in config.ms.users) {
        this._msClients.push(new MSClient(this));
        try {
            await this._msClients[key].connect(config.ms.host, config.ms.users[key].user, config.ms.users[key].password);
        } catch (err) {
            debug.enable("MSG");
            console.error(this._lc, "Error while communicating to the Miniserver");
            if (err.errorCode == 401)
                console.error(this._lc, "401 returned during password based authentication");
            else
                console.error(this._lc, "Unknown error. Consider increasing the log level");
            return;
        }
    }
    var client = this._msClients[0];

    // Search for this mediaServer instance and save its ID
    var mac = this._mac().replace(/:/g, "").toUpperCase();
    var serverUUID;
    for(let [key, value] of Object.entries(client.appConfig().mediaServer)) {
        if (value.mac == mac)
            serverUUID = key;
    }
    console.log(this._lc, "MUSIC SERVER UUID", serverUUID);

    var msZoneConfig = []
    for (let i = 0; i < config.zones; i++) {
        msZoneConfig.push({});
    }

    // Search for all zoneConfigs of this server
    for(let [key, value] of Object.entries(client.appConfig().controls)) {
        if (value.details && value.details.server == serverUUID) {
            console.log(this._lc, "MS ZONE CONFIG ", key, value);
            msZoneConfig[value.details.playerid] = value;
        }
    }

    // Find the uuids for all users for which we want to keep the settings in sync
    var users = JSON.parse((await client.command("jdev/sps/getuserlist2")).LL.value);
    console.log(this._lc, "AVAILABLE USERS", users);

    var msClientMap = {}
    for (key in this._msClients) {
        let usrObj = users.find( element => { return this._msClients[key].user() == element.name });

        msClientMap[usrObj.uuid] = this._msClients[key];
    }
    console.log(this._lc, "USER MAP", Object.keys(msClientMap));

    // Register a callback handler to get notified when the usersettings changes
    // This also gets called for the initial value
    var userSettingUUID = client.appConfig().globalStates.userSettings;
    var currentTS = undefined;

    // Only register on one client
    // The change request contains the information which user settings changed
    client.onChanged(userSettingUUID, async (event) => {          
        console.log(this._lc, "Incoming settings update: current Timestamp:", currentTS);
        // identify which user has changed and get the socket for this user
        var text = JSON.parse(event.text);
        var keys = Object.keys(text);
        var client = undefined;
        console.log(this._lc, "Updated settings keys:", keys);
        if (keys.length) {
            for (var i in keys) {
                var userUUid = keys[i];
                var ts = text[userUUid];

                console.log(this._lc, "Timestamp of settings object:");
                console.log(this._lc, userUUid, ts);

                // Ignore events for all users not in our list
                var newClient = msClientMap[userUUid];
                if (!newClient) {
                    console.log(this._lc, "ignoring update: unknown user");
                    continue;
                }

                // All changes <= the current timestamp are ignored
                if (currentTS && ts <= currentTS) {
                    console.log(this._lc, "ignoring update: same timestamp (no change)");
                    continue;
                }

                client = newClient;
                break;
            }
        } else { // If there no text data is provided we requested the change
            client = this._msClients[0];
            console.log(this._lc, "no settings object in settings update: Using first user");
        }

        if (!client)
            return;

        console.log(this._lc, "Update from user: ", client.user());

        // get the new settings
        var response = await client.command("jdev/sps/getusersettings");
        var accounts = response.currentSpotifyAccount;
        console.log(this._lc, "new Account Settings", accounts);

        // Calculate timestamp
        var currentDate= await client.command("jdev/sys/date");
        var currentTime = await client.command("jdev/sys/time");
        var now = new Date(currentDate.LL.value + "T" + currentTime.LL.value);
        var then = new Date(2009,0,1,1,0,0) // 1.1.2019 00:00
        currentTS = Math.floor((now.getTime() - then.getTime()) / 1000);
        console.log(this._lc, "new TS for settings update", currentTS);

        // save new account for all other users
        for (var key in this._msClients) {
            if (this._msClients[key] == client)
                continue;

            var cur_client = this._msClients[key]
            console.log(this._lc, "Updating settings for user:", cur_client.user())
            // get settings
            var response = await cur_client.command("jdev/sps/getusersettings");
            // modify account
            response.currentSpotifyAccount = accounts;
            response.ts = currentTS;
            // write settings
            await cur_client.command("jdev/sps/setusersettings/" + currentTS + "/" + JSON.stringify(response));
        }

        // Switch all zones to the spotify accounts from the settings
        for(let [key, value] of Object.entries(accounts)) {
            let config = msZoneConfig.find( element => { return key == element.uuidAction });
            if (!config) {
                console.log(this._lc, "Couldn't find zone:", key);
                continue;
            }

            this._zones[config.details.playerid - 1].switchSpotifyAccount(value);
        }
    });

    // Request getting notifications for all value changes
    await client.command("jdev/sps/enablebinstatusupdate");
  }

  call(method, uri, body = null) {
    const url = this._config.gateway + uri;

    const data =
      method === 'POST' || method === 'PUT'
        ? JSON.stringify(body, null, 2)
        : '';

    console.log(this._lc, '--> [CALL] Calling ' + method + ' to ' + url);

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

  async pushQueueEvent(zone) {
    this._pushQueueEvents([zone]);

    const zoneId = this._zones.indexOf(zone) + 1;
    const syncInfo = this._getSyncedGroupInfo(zoneId);
    if (syncInfo) {
        var zones = []
        for (var i in syncInfo.members) {
            if (zoneId != syncInfo.members[i]) {
                const zoneObj = this._zones[syncInfo.members[i] - 1];
                await zoneObj.getState();
                this._pushQueueEvents([zoneObj]);
            }
        }
    }
  }

  _pushAudioEvents(zones) {

    const audioEvents = zones.map((zone) => {
      return this._getAudioState(zone);
    });

    const audioEventsMessage = JSON.stringify({
      audio_event: audioEvents,
    });

    console.log(this._lcEVNT, JSON.stringify(audioEventsMessage));

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

    console.log(this._lcEVNT, JSON.stringify(audioSyncEventsMessage));

    this._wsConnections.forEach((connection) => {
      connection.send(audioSyncEventsMessage);
    });
  }

  _pushFavoritesChangedEvent() {
    const favoritesChangedEventMessage = JSON.stringify({
      favoriteschanged_event: [],
    });

    console.log(this._lcEVNT, JSON.stringify(favoritesChangedEventMessage));

    this._wsConnections.forEach((connection) => {
      connection.send(favoritesChangedEventMessage);
    });
  }

  _pushInputsChangedEvent() {
    const inputsChangedEventMessage = JSON.stringify({
      lineinchanged_event: [],
    });

    console.log(this._lcEVNT, JSON.stringify(inputsChangedEventMessage));

    this._wsConnections.forEach((connection) => {
      connection.send(inputsChangedEventMessage);
    });
  }

  _pushLibraryChangedEvent() {
    const libraryChangedEventMessage = JSON.stringify({
      rescan_event: [{status: 0}],
    });

    console.log(this._lcEVNT, JSON.stringify(libraryChangedEventMessage));

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
      console.log(this._lcEVNT, JSON.stringify(message));
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
      console.log(this._lcEVNT, JSON.stringify(message));
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

     console.log(this._lcEVNT, JSON.stringify(playlistsChangedEventMessage));

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

      console.log(this._lcEVNT, JSON.stringify(message));

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

      console.log(this._lcEVNT, JSON.stringify(message));

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

      console.log(this._lcEVNT, JSON.stringify(message));

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
            console.error(this._lc, 'Invalid events endpoint: ' + err.message);
          });
        },
      )
      .on('error', (err) => {
        console.error(this._lc, 'Invalid events endpoint: ' + err.message);
      });
  }

  _sseHandler(url) {
    switch (true) {
      case /^(data:)\s*\/favorites\/\d+\s*$/.test(url): {
        const [, , position] = url.split('/');

        this._master.getFavoriteList().reset(+position);
        this._pushFavoritesChangedEvent();

        console.log(this._lc, '<-- [EVTS] Reset favorites');

        break;
      }

      case /^(data:)?\s*\/inputs\/\d+\s*$/.test(url): {
        const [, , position] = url.split('/');

        this._master.getInputList().reset(+position);
        this._pushInputsChangedEvent();

        console.log(this._lc, '<-- [EVTS] Reset inputs');

        break;
      }

      case /^(data:)?\s*\/library\/\d+\s*$/.test(url): {
        const [, , position] = url.split('/');

        this._master.getLibraryList().reset(+position);
        this._pushLibraryChangedEvent();
        console.log(this._lc, '<-- [EVTS] Reset library');

        break;
      }

      case /^(data:)?\s*\/playlists\/\d+\s*$/.test(url): {
        const [, , position] = url.split('/');

        this._master.getPlaylistList().reset(+position);
        this._pushPlaylistsChangedEvent();
        console.log(this._lc, '<-- [EVTS] Reset playlists');

        break;
      }

      case /^(data:)?\s*\/zone\/\d+\/favorites\/\d+\s*$/.test(url): {
        const [, , zoneId, , position] = url.split('/');
        const zone = this._zones[+zoneId - 1];

        zone.getFavoritesList().reset(+position);
        this._pushRoomFavChangedEvents([zone]);

        console.log(this._lc, '<-- [EVTS] Reset zone favorites');

        break;
      }

      case /^(data:)?\s*\/zone\/\d+\/state\s*$/.test(url): {
        const [, , zoneId] = url.split('/');
        const zone = this._zones[+zoneId - 1];

        zone.getState();
        // No need to push an event, getState does it automatically.

        console.log(this._lc, '<-- [EVTS] Reset zone favorites');

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

      case /(?:^|\/)audio\/cfg\/playlist\/update(?:\/|$)/.test(url):
        return this._audioCfgPlaylistUpdate(url);

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

      case /(?:^|\/)audio\/cfg\/audiodelay(?:\/|$)/.test(url):
        return this._audioCfgAudioDelay(url);

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

      case /(?:^|\/)audio\/cfg\/roomfavs\/\d+\/copy\/\d+/.test(url):
        return this._audioRoomFavsCopy(url);

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

      case /(?:^|\/)audio\/\d+\/tts\/[^\/]+\/\d+(?:\/|$)/.test(url):
        return this._audioTTS(url);

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

    var favId = undefined
    for (var i in items) {
        if (items[i].id == decodedId) {
            favId = items[i].favId;
            break;
        }
    }
    if (!favId) {
        console.warn(this._lc, "Coudln't find the requested favorite");
        return this._emptyCommand(url, []);
    }

    await this._master.getFavoriteList().delete(favId, 1);

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

    return this._response(url, 'getradios', items.map((item, i) =>{
        if (item && item.image)
            item.coverurl = this._imageUrl(item.image)
        return item
    }));
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

    return this._emptyCommand(url, []);
  }

  async _audioCfgGetServiceFolder(url) {
    let [, , , service, user, requestId, start, length] = url.split('/');

    let rootItem = service + '%%%' + user;

    if (requestId != 0 && requestId != 'start') {
        const [decodedId] = this._decodeId(requestId);
        rootItem = rootItem + '%%%' + decodedId;
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
            const base = type == 'local' ? BASE_LIBRARY : BASE_SERVICE;
            response.items = response.items.map(this._convert(2, base)),
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
          console.log(this._lcHTTP, 'RESP:', JSON.stringify(search_response));
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

    await this._master.getPlaylistList().insert(undefined, {
      id: null,
      title,
      image: null,
    });

    return this._emptyCommand(url, []);
  }

  async _audioCfgPlaylistUpdate(url) {
    const parts = url.split('/');
    const [cmd, id] = parts.pop().split(':');
    const encoded_playlist_id = parts.pop();
    const [playlist_id] = this._decodeId(encoded_playlist_id);

    var response = [];
    if (cmd == 'start' || cmd == 'finish' || cmd == 'finishnochanges') {
        this._pushPlaylistsChangedEvent(encoded_playlist_id, cmd);
    } else {
        const [decodedId] = this._decodeId(id);
        const playlists = this._master.getPlaylistList();
        const current_list = await playlists.get(playlist_id, 0, 500);

        await playlists.insert(playlist_id, { id: decodedId });

        let resp = await playlists.get(playlist_id, +current_list.total, 500);
        response = [{"action":"ok", "items": resp.items.map(this._convert(11, BASE_PLAYLIST, +current_list.count))}];
    }

    return this._emptyCommand(url, response);
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
        console.error(this._lc, "Couldn't decrypt password: " + err.message);
    }

    return this._emptyCommand(url, { configerror });
  }

  async _audioCfgDefaultVolume(url) {
    const [, , , zoneId, volume] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    if (volume) {
      await zone.defaultVolume(+volume);
    }

    return this._emptyCommand(url, []);
  }

  async _audioCfgMaxVolume(url) {
    const [, , , zoneId, volume] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    if (volume) {
      await zone.maxVolume(+volume);
    }

    return this._emptyCommand(url, []);
  }

  async _audioCfgEventVolumes(url) {
    const [, , , zoneId, volumeString] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    //TODO unclear what to do here, as the values are saved on the miniserver
    //     and we don't know how to get the inital values.

    return this._emptyCommand(url, []);
  }

  async _audioCfgAudioDelay(url) {
    const [, , , zoneId, delay] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    var newDelay = 0
    if (!delay)
        newDelay = zone.getAudioDelay();
    else
        zone.audioDelay(delay);

    return this._emptyCommand(url, [{ "audio_delay": newDelay }]);
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

    return this._emptyCommand(url, []);
  }

  async _audioLineIn(url) {
    const [, zoneId, id] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId, favoriteId] = this._decodeId(id.replace(/^linein/, ''));

    await zone.play(decodedId, favoriteId);

    return this._emptyCommand(url, []);
  }

  async _audioOff(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.power('off');

    return this._emptyCommand(url, []);
  }

  async _audioOn(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.power('on');

    return this._emptyCommand(url, []);
  }

  async _audioSleep(url) {
    const [, zoneId, ,duration] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.sleep(+duration);

    return this._emptyCommand(url, []);
  }

  async _audioPause(url) {
    const [, zoneId, , volume] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.pause();

    return this._emptyCommand(url, []);
  }

  async _audioStop(url) {
    const [, zoneId, , volume] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.stop();

    return this._emptyCommand(url, []);
  }

  async _audioPlay(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    if (zone.getMode() === 'stop') {
      //If the playqueue is empty start the first room favorite
      if (zone.getTrack().id == "")
        await this._audioRoomFavPlay('audio/' + zoneId + "/roomfav/play/1");
      else
        await zone.play(null, 0);
    } else {
      await zone.resume();
    }

    return this._emptyCommand(url, []);
  }

  async _audioPlayUrl(url) {
    const [, zoneId, , ...lastArg] = url.split('/');
    let id = lastArg.join('/');
    const zone = this._zones[+zoneId - 1];
    var decodedId, favoriteId;
    if (id.includes("/parentpath/"))
        id = lastArg[0];
    try {
       [decodedId, favoriteId] = this._decodeId(id);
    } catch {}

    if (decodedId)
        await zone.play(decodedId, favoriteId);
    else
        await zone.play("url:" + id);

    return this._emptyCommand(url, []);
  }

  async _audioPlaylist(url) {
    const [, zoneId, , , id] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId, favoriteId] = this._decodeId(id);

    await zone.play(decodedId, favoriteId);

    return this._emptyCommand(url, []);
  }

  async _audioPosition(url) {
    const [, zoneId, , time] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.time(+time * 1000);

    return this._emptyCommand(url, []);
  }

  _audioQueueMinus(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    if (zone.getTime() < 3000) {
      zone.previous();
    } else {
      zone.time(0);
    }

    return this._emptyCommand(url, []);
  }

  _audioQueuePlus(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    zone.next();

    return this._emptyCommand(url, []);
  }

  async _audioQueueIndex(url) {
    const [, zoneId, , index] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.setCurrentIndex(index);

    return this._emptyCommand(url, []);
  }

  async _audioQueueDelete(url) {
    const [, zoneId, , position] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.getQueueList().delete(+position, 1);
    if (!zone.getQueueList().canSendEvents)
        this._pushQueueEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioQueueClear(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.getQueueList().clear();
    if (!zone.getQueueList().canSendEvents)
        this._pushQueueEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioQueueMove(url) {
    const [, zoneId, , position, destination] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.getQueueList().move(+position, +destination);
    if (!zone.getQueueList().canSendEvents)
       this._pushQueueEvents([zone]);

    return this._emptyCommand(url, []);
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
    if (!zone.getQueueList().canSendEvents)
        this._pushQueueEvents([zone]);

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
    if (!zone.getQueueList().canSendEvents)
        this._pushQueueEvents([zone]);

    return this._emptyCommand(url, []);
  }

  _audioRepeat(url) {
    const [, zoneId, , repeatMode] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const repeatModes = {0: 0, 1: 2, 3: 1};

    zone.repeat(repeatModes[repeatMode]);

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavDelete(url) {
    const [, zoneId, , , position, id, title] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    await zone.getFavoritesList().delete(+position - 1, 1);
    if (!zone.getFavoritesList().canSendEvents)
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

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavPlus(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[+zoneId - 1];

    if (zone.getMode() === 'stop') {
        //If the playqueue is empty start the first room favorite
        if (zone.getTrack().id == "")
            await this._audioRoomFavPlay('audio/' + zoneId + "/roomfav/play/1");
        else
            await zone.play(null, 0);
        return this._emptyCommand(url, []);
    }

    const favoriteId = zone.getFavoriteId();
    const favorites = await zone.getFavoritesList().get(undefined, 0, 8);

    let position =
      BASE_DELTA * Math.floor(favoriteId / BASE_DELTA) === BASE_FAVORITE_ZONE
        ? (favoriteId % BASE_FAVORITE_ZONE) + 1
        : 0;

    for (; position < 16; position++) {
      if (favorites.items[position % 8] &&
          favorites.items[position % 8].id) {
        position = position % 8;
        break;
      }
    }

    const id = favorites.items[position].id;

    await zone.playRoomFav(id, BASE_FAVORITE_ZONE + position, favorites.items[position].title);

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
    if (!zone.getFavoritesList().canSendEvents)
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
    if (!zone.getFavoritesList().canSendEvents)
        this._pushRoomFavChangedEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavsCopy(url) {
    const [, , , source, , destination] = url.split('/');

    const srcZone = this._zones[+source - 1];
    const destZone = this._zones[+destination - 1];

    var data = await srcZone.getFavoritesList().get(undefined, 0, 8);

    for (var i=0; i < 8; i++) {
        await destZone.getFavoritesList().replace(i, data.items[i]);
    }

    return this._emptyCommand(url, []);
  }

  async _audioServicePlay(url) {
    const [, zoneId, , , , id] = url.split('/');
    const zone = this._zones[+zoneId - 1];
    const [decodedId, favoriteId] = this._decodeId(id);

    await zone.play(decodedId, favoriteId);

    return this._emptyCommand(url, []);
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

    return this._emptyCommand(url, []);
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
      //If the playqueue is empty start the first room favorite
      if (zone.getTrack().id == "")
        await this._audioRoomFavPlay('audio/' + zoneId + "/roomfav/play/1");
      else
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

    return this._emptyCommand(url, []);
  }

  async _audioTTS(url) {
    const [, zoneId, , input, volume] = url.split('/');
    const [language, text] = input.split('|');
    const zone = this._zones[+zoneId - 1];

    zone.tts(language, text, volume);

    return this._emptyCommand(url, []);
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
    console.warn(this._lc, '[HTWS] Unknown command: ' + url);

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
      if (!item || !item.id) {
        return {
          type,
          slot: +start + i + 1,
          qindex: +start + i + 1,
          isAnEmptySlot: true,
          name: '',
        };
      }

      this._imageStore[item.id] = item.image;
      type = item.type ? item.type : type;
      let newBase = base
      if (start != undefined)
            newBase += i;
      var lastSelectedItem = undefined;

      var contentType = "";
      var mediaType = "";
      if (base == BASE_SERVICE) {
         contentType = "Service";
         mediaType = "service";
      } else if (base == BASE_PLAYLIST) {
         contentType = "Playlists";
         mediaType = "playlist";
      } else if (base == BASE_LIBRARY) {
         contentType = "Library";
         mediaType = "library";
      } else if (base == BASE_INPUT) {
         contentType = "LineIn";
         mediaType = "input";
      } else if (base == BASE_FAVORITE_ZONE ||
                 base == BASE_FAVORITE_GLOBAL) {
         contentType = "ZoneFavorites";
         mediaType = "favorites";
      }

      var result = {
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
        username: item.username ? item.username : undefined,
        identifier: item.identifier ? item.identifier : undefined,
        lastSelectedItem: lastSelectedItem,
        contentType,
        mediaType
      };

      // This is needed to be able to show the correct view when saving it as a shortuct
      if (item.lastSelectedItem) {
          result.lastSelectedItem = JSON.parse(JSON.stringify(result));;
      }

      return result;
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
