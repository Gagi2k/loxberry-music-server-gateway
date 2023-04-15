'use strict';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';


const http = require('http');
const cors_proxy = require('cors-anywhere');
const querystring = require('querystring');
const websocket = require('websocket');
const fs = require('fs');
const os = require('os');
const NodeRSA = require('node-rsa');
const debug = require('debug');
const axios = require('axios');
const crc32 = require("crc/crc32");
const lcApp = debug('MSG');

const config = JSON.parse(fs.readFileSync("config.json"));

const MusicMaster = require(config.plugin == "lms" ? './lms/music-master' : './music-master');
const MusicZone = require(config.plugin == "lms" ? './lms/music-zone' : './music-zone');

const Log = require("./log");
const console = new Log;

const MSClient = require("./ms-client")

const path = require('path');

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

function getKeyByValue(object, value) {
  return Object.keys(object).find(key => object[key] === value);
}

module.exports = class MusicServer {
  constructor(cfg) {

    const zones = {};

    this._config = cfg;
    this._zones = zones;
    this._lc = lcApp;
    this._lcWSCK = lcApp.extend("WSCK");
    this._lcMSWSCK = lcApp.extend("MSWSCK");
    this._lcHTTP = lcApp.extend("HTTP");
    this._lcMSHTTP = lcApp.extend("MSHTTP");
    this._lcEVNT = lcApp.extend("EVNT");

    // setup the default logging categories
    if (!process.env.DEBUG)
        debug.enable('MSG,MSG:WSCK,MSG:MSWSCK,MSG:HTTP,MSG:MSHTTP,MSG:EVNT');

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

        console.log(this._lc, "Custom Keys loaded!")
    } else {
        this._rsaKey = new NodeRSA({b: 1024});
    }
    this._rsaKey.setOptions({encryptionScheme: 'pkcs1'});

    // Parse API version from string to make the settings backward compatible
    this._apiVersion = config.msApi.match(/V ((\d+\.)?(\d+\.)?(\d+\.)?(\d+)?)/)[1];
    this.masterZoneName = Object.keys(config.zone_map)[0];

    if (config.type == "musicserver") {
      for (let i = 0; i < config.zones; i++) {
        if (config.zone_map[i +1]) {
          console.log(this._lc, "Adding Zone:", i+1, "with mac:", config.zone_map[i +1]);
          zones[i+1] = new MusicZone(this, i + 1, this);
          if (i == this.masterZoneName) {
            console.log(this._lc, "Adding Zone:", i+1, "as master zone");
            this._masterZone = zones[i]
          }
        } else {
          console.log(this._lc, "Adding UNCONFIGURED Zone:", i+1);
          zones[i+1] = new MusicZone(this, i + 1 , this);
        }
      }
      this._master = new MusicMaster(this);
    }
  }

  loggingCategory() {
    return this._lc;
  }

  async start() {
    if (this._httpServer || this._wsServer || this._dgramServer) {
      throw new Error('Music server already started');
    }

    // Connect to the Miniserver as early as possible
    // Afterwards we have all the information to also do secure communication
    await this.connectToMiniserver();

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
            var jsonheaders = headers;
            jsonheaders['Content-Type'] = 'application/json';
            res.writeHead(200, jsonheaders);
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

      console.log(this._lcWSCK, 'New Connection from:', connection.remoteAddress);

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

      // Example version strings
      // 1.4.10.06 | ~API:1.6~
      // 2.3.9.1 | ~API:1.6~
      connection.send("LWSS V " + this._apiVersion + " | ~API:1.6~ | Session-Token: 8WahwAfULwEQce9Yu0qIE9L7QMkXFHbi0M9ch9vKcgYArPPojXHpSiNcq0fT3lqL");

      // All those Events are send when a new client connects
      // E.g. opening the App, but also when switching back to the
      // app which was just minimized
      setTimeout(async () => {
          // the delay in sending this info helps to fix a problem
          // where the current sync state is not shown correctly
          this._pushAudioEvents(this._zones);
          this._pushAudioSyncEvents();
          this.pushMasterVolumeChangedEvent();
      }, 500);

      if (!this._msClients || !this._msClients[0].isSocketOpen()) {
        this.connectToMiniserver();
      }
    });

    httpServer.listen(this._config.port);
    if (config.cors_port)
        cors_proxy.createServer().listen(config.cors_port)


    const msHttpServer = http.createServer(async (req, res) => {
      console.log(this._lcMSHTTP, 'RECV:' + req.url);
    });

    const msWsServer = new websocket.server({
      httpServer: msHttpServer,
      autoAcceptConnections: true,
    });

    msWsServer.on('connect', (connection) => {
      this._wsConnections.add(connection);

      console.log(this._lcMSWSCK, 'New Connection from:', connection.remoteAddress);

      connection.on('message', async (message) => {
        console.log(this._lcMSWSCK, 'RECV:' + message.utf8Data);

        if (message.type !== 'utf8') {
          throw new Error('Unknown message type: ' + message.type);
        }

        const response = await this._handler(message.utf8Data);
        console.log(this._lcMSWSCK, 'RESP:', JSON.stringify(JSON.parse(response)));
        connection.sendUTF(response);
      });

      connection.on('close', () => {
        this._wsConnections.delete(connection);
      });

      var mac = this._mac().replace(/:/g, "").toUpperCase();
      connection.send("MINISERVER V " + this._apiVersion + " " + mac + " | ~API:1.6~ | Session-Token: 8WahwAfULwEQce9Yu0qIE9L7QMkXFHbi0M9ch9vKcgYArPPojXHpSiNcq0fT3lqL");


      if (!this._msClients || !this._msClients[0].isSocketOpen()) {
        this.connectToMiniserver();
      }
    });

    if (config.type == "audioserver") {
        msHttpServer.listen(7095);
    }

    // The SSE is not needed when directly talking to the LMS
    if (config.plugin != "lms") {
        this._initSse();
    }

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

    if (config.type == "audioserver") {
        await this.prepareAudioserverConfig();
        // Return here as we can't use the same settings handling right now.
        return;
    }

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

        if (usrObj.hasOwnProperty('uuid'))
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
        if (!accounts) {
            console.log(this._lc, "NO Account Settings!!!!!!!!");
            return;
        }

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

            await this._zones[config.details.playerid - 1].switchSpotifyAccount(value);
        }
    });

    // Request getting notifications for all value changes
    await client.command("jdev/sps/enablebinstatusupdate");

    console.log(this._lc, "connectToMiniserver DONE");
  }

  async prepareAudioserverConfig() {
    this.msMAC = (await this._msClients[0].command("jdev/cfg/mac")).LL.value.replace(/:/g, "").toUpperCase();

    // Prepare a list of extensions for autodiscovery
    this.extensions = []
    for (var i=0; i<10 ;i++) {
        var mac = "504F94FF1B0" + i;
        this.extensions.push({"version": "1.2.3","mac": mac,"serial": mac,"blinkpos":0,"type":3,"subtype":1,"btenable":false})
    }

    // Send a HW event every minute
    var startDate = Date.now();
    setInterval(() => {
        var now = Date.now();
        var delta = now - startDate;
        if (delta > (60 * 60 * 24)) {
            startDate = now;
        }
        this._pushHwEvent(Math.floor(delta / 1000));
    }, 1000 * 60);

    if (fs.existsSync(".music.json")) {
        let rawdata = fs.readFileSync(".music.json");
        this.musicJSON = JSON.parse(rawdata);
        this.musicCRC = crc32(rawdata).toString(16);
        const thisMac = this._mac().replace(/:/g, "").toUpperCase()

        // Inform the Miniserver that the Audioserver is starting up and the Miniserver can now
        // connect to it.
        for(let [key, value] of Object.entries(this.musicJSON)) {
            if (!(thisMac in value))
                continue;
            this.msMAC = value[thisMac].master;

            await axios({
                url: config.ms.host + '/dev/sps/devicestartup/' + value[thisMac].uuid,
                method: 'get',
                data: {} // Request Body if you have
            });
        }
    }
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

    const zoneId = getKeyByValue(this._zones, zone);
    const syncInfo = this._getSyncedGroupInfo(zoneId);
    if (syncInfo) {
        var zones = []
        for (var i in syncInfo.members) {
            if (zoneId != syncInfo.members[i]) {
                const zoneObj = this._zones[syncInfo.members[i]];
                await zoneObj.getState();
                this._pushAudioEvents([zoneObj]);
            }
        }


        var groups = this._getSyncState();
        this._pushMasterVolumeChangedEvent(groups[syncInfo.groupIndex].group, groups[syncInfo.groupIndex].mastervolume);
    }
  }

  pushRoomFavEvent(zone) {
    this._pushRoomFavEvents([zone]);
  }

  async pushQueueEvent(zone) {
    this._pushQueueEvents([zone]);

    const zoneId = getKeyByValue(this._zones, zone);
    const syncInfo = this._getSyncedGroupInfo(zoneId);
    if (syncInfo) {
        var zones = []
        for (var i in syncInfo.members) {
            if (zoneId != syncInfo.members[i]) {
                const zoneObj = this._zones[syncInfo.members[i]];
                await zoneObj.getState();
                this._pushQueueEvents([zoneObj]);
            }
        }
    }
  }

  pushMasterVolumeChangedEvent() {
    var groups = this._getSyncState();

    for (var i in groups) {
        let group = groups[i].group
        let mastervolume = groups[i].mastervolume

        this._pushMasterVolumeChangedEvent(group, mastervolume);
    }
  }

  _pushAudioEvents(zones) {

    const audioEvents = Object.values(zones).map((zone) => {
      return this._getAudioState(zone);
    });

    const audioEventsMessage = JSON.stringify({
      audio_event: audioEvents,
    });

    console.log(this._lcEVNT, audioEventsMessage);

    this._wsConnections.forEach((connection) => {
      connection.send(audioEventsMessage);
    });
  }

  _pushAudioSyncEvents() {
    var groups = this._getSyncState();

    const audioSyncEventsMessage = JSON.stringify({
      audio_sync_event: groups
    });

    console.log(this._lcEVNT, audioSyncEventsMessage);

    this._wsConnections.forEach((connection) => {
      connection.send(audioSyncEventsMessage);
    });
  }

  _pushMasterVolumeChangedEvent(group, mastervolume) {
    const masterVolumeChangedEventMessage = JSON.stringify({
      mastervolumechanged_event: { group, mastervolume }
    });

    console.log(this._lcEVNT, masterVolumeChangedEventMessage);

    this._wsConnections.forEach((connection) => {
      connection.send(masterVolumeChangedEventMessage);
    });
  }

  _pushFavoritesChangedEvent() {
    const favoritesChangedEventMessage = JSON.stringify({
      favoriteschanged_event: [],
    });

    console.log(this._lcEVNT, favoritesChangedEventMessage);

    this._wsConnections.forEach((connection) => {
      connection.send(favoritesChangedEventMessage);
    });
  }

  _pushInputsChangedEvent() {
    const inputsChangedEventMessage = JSON.stringify({
      lineinchanged_event: [],
    });

    console.log(this._lcEVNT, inputsChangedEventMessage);

    this._wsConnections.forEach((connection) => {
      connection.send(inputsChangedEventMessage);
    });
  }

  _pushLibraryChangedEvent() {
    const libraryChangedEventMessage = JSON.stringify({
      rescan_event: [{status: 0}],
    });

    console.log(this._lcEVNT, libraryChangedEventMessage);

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
      console.log(this._lcEVNT, message);
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
      console.log(this._lcEVNT, message);
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

     console.log(this._lcEVNT, playlistsChangedEventMessage);

     this._wsConnections.forEach((connection) => {
       connection.send(playlistsChangedEventMessage);
     });
  }

  _pushRoomFavEvents(zones) {
    zones.forEach((zone) => {
      const message = JSON.stringify({
        roomfav_event: [
          {
            'playerid': +getKeyByValue(this._zones, zone),
            'playing slot': zone.getFavoriteId(),
          },
        ],
      });

      console.log(this._lcEVNT, message);

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
            playerid: +getKeyByValue(this._zones, zone),
          },
        ],
      });

      console.log(this._lcEVNT, message);

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
            playerid: +getKeyByValue(this._zones, zone),
          },
        ],
      });

      console.log(this._lcEVNT, message);

      this._wsConnections.forEach((connection) => {
        connection.send(message);
      });
    });
  }

  _pushRebootEvent() {
      const message = JSON.stringify({
        reboot_event: true
      });
      console.log(this._lcEVNT, message);
      this._wsConnections.forEach((connection) => {
        connection.send(message);
      });
  }

  _pushHwEvent(uptimeSeconds) {
      // Sent every minute
      // 2104: online state of extension (two per extension, one per channel)
      // 2105: online since seconds

      const thisMac = this._mac().replace(/:/g, "").toUpperCase()

      var events = [
          {"client_id":thisMac + "#1","event_id":2005,"value":0},
          {"client_id":thisMac + "#1","event_id":2101,"value":67},
          {"client_id":thisMac + "#1","event_id":2100,"value":0},
          {"client_id":thisMac + "#1","event_id":2102,"value":0},
          {"client_id":thisMac + "#1","event_id":2103,"value":0},
          {"client_id":thisMac + "#1","event_id":2105,"value":uptimeSeconds},
          {"client_id":thisMac + "#1","event_id":2106,"value":56},
      ]

      for (var i in this.extensions) {
        for (var j = 1; j<3 ;j++) {
            events.push({"client_id":this.extensions[i].mac + "#" + j,"event_id":2100,"value":0})
            events.push({"client_id":this.extensions[i].mac + "#" + j,"event_id":2101,"value":0})
            events.push({"client_id":this.extensions[i].mac + "#" + j,"event_id":2102,"value":0})
            events.push({"client_id":this.extensions[i].mac + "#" + j,"event_id":2103,"value":0})
            events.push({"client_id":this.extensions[i].mac + "#" + j,"event_id":2104,"value":1})
            events.push({"client_id":this.extensions[i].mac + "#" + j,"event_id":2105,"value":uptimeSeconds})
        }
      }

      const message = JSON.stringify({ hw_event: events });
      console.log(this._lcEVNT, message);
      this._wsConnections.forEach((connection) => {
        connection.send(message);
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
        const zone = this._zones[zoneId];
        if (!zone)
          break;

        zone.getFavoritesList().reset(+position);
        this._pushRoomFavChangedEvents([zone]);

        console.log(this._lc, '<-- [EVTS] Reset zone favorites');

        break;
      }

      case /^(data:)?\s*\/zone\/\d+\/state\s*$/.test(url): {
        const [, , zoneId] = url.split('/');
        const zone = this._zones[zoneId];
        if (!zone)
          break;

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
      case /(?:^|\/)poweroff(?:\/|$)/.test(url):
        return this._powerOff(url);

      case /(?:^|\/)audio\/cfg\/all(?:\/|$)/.test(url):
        return this._audioCfgAll(url);

      case /(?:^|\/)audio\/cfg\/equalizer\//.test(url):
        return this._audioCfgEqualizer(url);

      case /(?:^|\/)audio\/cfg\/geteq\//.test(url):
        return this._audioCfgGetEq(url);

      case /(?:^|\/)audio\/cfg\/seteq/.test(url):
        return this._audioCfgSetEq(url);

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

      case /(?:^|\/)audio\/cfg\/getmonitorstatus(?:\/|$)/.test(url):
        return this._audioCfgGetMonitorStatus(url);

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

      case /(?:^|\/)audio\/cfg\/iamaminiserver(?:done)?/.test(url):
        return this._audioCfgIAmAMiniserver(url);

      case /(?:^|\/)audio\/cfg\/miniserverversion\//.test(url):
        return this._audioCfgMiniserverVersion(url);

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

      case /(?:^|\/)audio\/cfg\/props\/updatelevel/.test(url):
        return this._audioCfgPropsUpdateLevel(url);

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

      case /(?:^|\/)audio\/grouped\/(?:(fire)?alarm|bell|wecker|buzzer)(?:\/|$)/.test(url):
        return this._playGroupedAlarm(url);

      case /(?:^|\/)audio\/grouped\/tts(?:\/|$)/.test(url):
        return this._playGroupedTTS(url);

      case /(?:^|\/)audio\/cfg\/defaultvolume(?:\/|$)/.test(url):
        return this._audioCfgDefaultVolume(url);

      case /(?:^|\/)audio\/cfg\/maxvolume(?:\/|$)/.test(url):
        return this._audioCfgMaxVolume(url);

      case /(?:^|\/)audio\/cfg\/eventvolumes(?:\/|$)/.test(url):
        return this._audioCfgEventVolumes(url);

      case /(?:^|\/)audio\/cfg\/audiodelay(?:\/|$)/.test(url):
        return this._audioCfgAudioDelay(url);

      case /(?:^|\/)audio\/\d+\/(?:(fire)?alarm|bell|wecker|buzzer)(?:\/|$)/.test(url):
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

      case /(?:^|\/)audio\/\d+\/play\/alsaloop/.test(url):
        return this._audioPlayAlsaLoop(url);

      case /(?:^|\/)audio\/\d+\/(?:play|resume)(?:\/|$)/.test(url):
        return this._audioPlay(url);

      case /(?:^|\/)audio\/\d+\/playurl\//.test(url):
        return this._audioPlayUrl(url);

      case /(?:^|\/)audio\/\d+\/addurl\//.test(url):
        return this._audioAddUrl(url);

      case /(?:^|\/)audio\/\d+\/inserturl\//.test(url):
        return this._audioInsertUrl(url);

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

     case /(?:^|\/)audio\/\d+\/queue\/play\/\d+(\/|$)/.test(url):
       return this._audioQueuePlay(url);

      case /(?:^|\/)audio\/\d+\/queueremove\/\d+(\/|$)/.test(url):
        return this._audioQueueDelete(url);

      case /(?:^|\/)audio\/\d+\/queue\/remove\/\d+(\/|$)/.test(url):
        return this._audioQueueRemove(url);

      case /(?:^|\/)audio\/\d+\/queue\/clear(\/|$)/.test(url):
        return this._audioQueueClear(url);

      case /(?:^|\/)audio\/\d+\/queuemove\/\d+\/\d+(\/|$)/.test(url):
        return this._audioQueueMove(url);

      case /(?:^|\/)audio\/\d+\/queue\/move\/\d+\/before\/\d+(\/|$)/.test(url):
      case /(?:^|\/)audio\/\d+\/queue\/move\/\d+\/end/.test(url):
        return this._audioQueueMoveBefore(url);

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

     case /(?:^|\/)audio\/\d+\/roomfav\/play/.test(url):
        return this._audioRoomFavPlayId(url);

      case /(?:^|\/)audio\/[^\/]+\/roomfav\/play\/\d+(?:\/|$)/.test(url):
        return this._audioRoomFavPlayByName(url);

      case /(?:^|\/)audio\/\d+\/roomfav\/plus(?:\/|$)/.test(url):
        return this._audioRoomFavPlus(url);

      case /(?:^|\/)audio\/\d+\/roomfav\/savepath\/\d+\//.test(url):
      case /(?:^|\/)audio\/\d+\/roomfav\/saveid\/\d+\//.test(url):
        return this._audioRoomFavSavePath(url);

      case /(?:^|\/)audio\/\d+\/roomfav\/saveexternalid\/\d+\//.test(url):
        return this._audioRoomFavSaveExternalId(url);

      case /(?:^|\/)audio\/cfg\/roomfavs\/\d+\/copy\/\d+/.test(url):
        return this._audioRoomFavsCopy(url);

      case /(?:^|\/)audio\/cfg\/roomfavs\/\d+\/reorder/.test(url):
        return this._audioRoomFavsReorder(url);

      case /(?:^|\/)audio\/cfg\/roomfavs\/\d+\/delete/.test(url):
        return this._audioRoomFavsDelete(url);

      case /(?:^|\/)audio\/cfg\/roomfavs\/\d+\/setplus/.test(url):
        return this._audioRoomFavsSetPlus(url);

      case /(?:^|\/)audio\/cfg\/roomfavs\/\d+\//.test(url):
        return this._audioRoomFavsAdd(url);

      case /(?:^|\/)audio\/\d+\/serviceplay\//.test(url):
        return this._audioServicePlay(url);

      case /(?:^|\/)audio\/\d+\/serviceplayinsert\//.test(url):
        return this._audioServicePlayInsert(url);

      case /(?:^|\/)audio\/\d+\/serviceplayadd\//.test(url):
        return this._audioServicePlayAdd(url);

      case /(?:^|\/)audio\/\d+\/shuffle/.test(url):
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


      // Audioserver support
      case /(?:^|\/)audio\/cfg\/ready/.test(url):
         return this._audioCfgReady(url);

      case /(?:^|\/)audio\/cfg\/reboot/.test(url):
         return this._audioCfgReboot(url);

      case /(?:^|\/)audio\/cfg\/diagnosis/.test(url):
         return this._audioCfgDiagnosis(url);

      case /(?:^|\/)audio\/cfg\/identify\/[^\/]+\/acoustic/.test(url):
         return this._audioCfgIdentifyAcoustic(url);

      case /(?:^|\/)audio\/cfg\/identify\/[^\/]+/.test(url):
         return this._audioCfgIdentify(url);

      case /(?:^|\/)audio\/\d+\/status/.test(url):
        return this._audioGetStatus(url);

      case /(?:^|\/)audio\/cfg\/getconfig/.test(url):
        return this._audioCfgGetConfig(url);

      case /(?:^|\/)audio\/cfg\/setconfig/.test(url):
         return this._audioCfgSetConfig(url);

      case /(?:^|\/)audio\/cfg\/miniservertime/.test(url):
         return this._audioCfgMiniservertime(url);

      case /(?:^|\/)audio\/cfg\/speakertype/.test(url):
        return this._audioCfgSpeakerType(url);

      case /(?:^|\/)audio\/cfg\/volumes/.test(url):
        return this._audioCfgVolumes(url);

      case /(?:^|\/)audio\/cfg\/playername/.test(url):
        return this._audioCfgPlayername(url);

      case /(?:^|\/)audio\/cfg\/playeropts/.test(url):
        return this._audioCfgPlayeropts(url);

      case /(?:^|\/)audio\/cfg\/dgroup/.test(url):
        return this._audioCfgDynamicGroup(url);

      case /(?:^|\/)audio\/grouped\/pause/.test(url):
        return this._playGroupedPause(url);

      case /(?:^|\/)audio\/grouped\/play/.test(url):
        return this._playGroupedPlay(url);

      case /(?:^|\/)audio\/\d+\/mastervolume/.test(url):
        return this._audioMasterVolume(url);

      case /(?:^|\/)secure\/hello/.test(url):
        return this._secureHello(url);

      case /(?:^|\/)secure\/init/.test(url):
        return this._secureInit(url);

      case /(?:^|\/)secure\/pair/.test(url):
        return this._securePair(url);

      case /(?:^|\/)secure\/forget/.test(url):
        return this._secureForget(url);

      case /(?:^|\/)secure\/info\/pairing/.test(url):
        return this._secureInfoPairing(url);

      case /(?:^|\/)secure\/authenticate/.test(url):
        return this._secureAuthenticate(url);

      default:
        return this._unknownCommand(url);
    }
  }

  async _powerOff(url) {
    await this._master.powerOff();
    return this._emptyCommand(url, []);
  }

  _audioCfgAll(url) {
//    if (config.type != "musicserver")
//        return this._emptyCommand(url, []);
    return this._response(url, 'configall', [
      {
        airplay: false,
        dns: '8.8.8.8',
        errortts: false,
        gateway: '0.0.0.0',
        hostname: 'loxberry-music-server-' + this._config.port,
        ip: this._hostIp,
        language: 'en',
        lastconfig: '',
        macaddress: this._mac(),
        mask: '255.255.255.255',
        master: true,
        maxplayers: this._config.players,
        ntp: '0.europe.pool.ntp.org',
        upnplicences: 0,
        usetrigger: false,
        players: Object.values(this._zones).map((zone) => {
        var zoneId = getKeyByValue(this._zones, zone);
        return {
          playerid: zoneId,
          players: [{playerid: zoneId}],
          clienttype: 0,
          default_volume: zone.getDefaultVolume(),
          enabled: true,
          internalname: 'zone-' + zoneId,
          max_volume: zone.getMaxVolume(),
          volume: zone.getVolume(),
          name: 'Zone ' + zoneId,
          upnpmode: 0,
          upnppredelay: 0,
        }}),
      },
    ]);
  }

  async _audioCfgEqualizer(url) {
    const [, , , zoneId, config] = url.split('/');
    const zone = this._zones[zoneId];
    const bands = config && config.replace("!", "").split(',').map(Number);
    let value;

    if (!zone) {
      return this._emptyCommand(url, []);
    }

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

  async _audioCfgGetEq(url) {
    const [, , , zoneId] = url.split('/');
    const zone = this._zones[zoneId];
    let values;
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    if (+zoneId <= 0) {
      values = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    } else {
      values = await zone.getEqualizer();
    }

   return this._response(url, 'geteq', values.map(function(cur, index, array) {
        const bands = ["31 Hz", "63 Hz", "125 Hz", "250 Hz", "500 Hz",
                       "1 kHz", "2 kHz", "4 kHz", "8 kHz", "16 kHz"];
        return {
                    id: index,
                    high: 10,
                    low: -10,
                    step: 0.5,
                    value: cur,
                    name: bands[index]
               }
   }));
  }

  async _audioCfgSetEq(url) {
    const [, , , zoneId, bandId, value] = url.split('/');
    const zone = this._zones[zoneId];
    let values;
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    if (value != undefined) {
        if (+zoneId <= 0) {
          values = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        } else {
          values = await zone.getEqualizer();
        }
        values[bandId] = +value;
    } else {
        values = bandId.replace("!", "").split(',').map(Number);
    }

    await zone.equalizer(values);
    return this._emptyCommand(url, []);
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
        icontype: icons[item.image] || 0,
        enabled: true,
        type:6,
        inputvolume: item.inputvolume || 100,
        cmd: item.cmd,
        as: item.id
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

  _audioCfgGetMonitorStatus(url) {
    return this._emptyCommand(url, []);
  }

  _audioCfgGetMaster(url) {
    return this._emptyCommand(url, {"ip":config.ms.host,"master":this.msMAC,"paired":true,"window":-81})
  }

  _audioCfgGetPlayersDetails(url) {
    const audioStates = Object.values(this._zones).map((zone) => {
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
      const zone = this._zones[zoneId];
      if (!zone) {
        return this._emptyCommand(url, []);
      }
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
    const zone = this._zones[zoneId];
    const [decodedId, favoriteId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.play(decodedId, favoriteId);

    return this._emptyCommand(url, []);
  }

  async _audioCfgGetServiceFolder(url) {
    let [, , , service, user, requestId, start, length] = url.split('/');

    let rootItem = service + '%%%' + user;

    if (requestId != 'start') {
        try {
            const [decodedId] = this._decodeId(requestId);
            rootItem = rootItem + '%%%' + decodedId;
        } catch (err) {
            if (service == "spotify" && config.type == "audioserver") {
                // UPDATE MAPPING WHEN SPOTTY CHANGES ITS FOLDER STRUCTURE
                const itemMap = {
                    '0' : 5, // Start
                    '1' : 2, // News
                    '2' : 4, // Genres
                    '3' : 9, // Playlists
                    '4' : 6, // Songs
                    '5' : 7, // Albums
                    '6' : 8, // Artists
                    '7' : 10 // Podcasts
                };
                rootItem = rootItem + '%%%' + itemMap[requestId];
            }
        }
    }

    const {total, items} = await this._master.getServiceFolderList().get(rootItem, start, length);

    return this._response(url, 'getservicefolder/' + service + '/' + user, [
      {
        id: requestId,
        totalitems: total,
        start: +start,
        name: items.length ? items[0].title : "",
        items: items.map(this._convert(2, BASE_SERVICE, +start)),
      },
    ]);

    return this._response(url, 'getservicefolder/' + service + '/' + user, items);
  }

  _audioCfgGetSyncedPlayers(url) {
    var groups = this._getSyncState();
    return this._emptyCommand(url, groups);
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
    const [, , , type, user, category, search, start, length] = url.split('/');

    // Otherwise the spotify search doesn't work correctly
    await this._master.getSearchableTypes()

    let data = await this._master.search(type, category, search, start, length);
    const base = type == 'library' ? BASE_LIBRARY : BASE_SERVICE;
    data.items = data.items.map(this._convert(2, base));

    return this._response(url, 'search/', [
      {
        results: [
            {
                // Limit the results to max 50
                totalitems: Math.min(data.count, 50),
                start: +start,
                items: data.items
            }
        ],
        where: type
      }
    ]);
  }

  _audioCfgIAmAMiniserver(url) {
    this._miniserverIp = url.split('/').pop();

    return this._response(url, 'iamamusicserver', {
      iamamusicserver: 'i love miniservers!',
    });
  }

  _audioCfgMiniserverVersion(url) {
    return this._emptyCommand(url, true);
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
    let inputs = await this._master.getInputList().get(undefined, 0, +Infinity);

    // create a deep copy
    inputs = JSON.parse(JSON.stringify(inputs));

    let item = inputs.items[position];
    item.title = decodeURIComponent(title);
    await this._master.getInputList().replace(position, item);

    return this._emptyCommand(url, []);
  }

  async _audioCfgInputType(url) {
    const [, , , id, , icon] = url.split('/');
    const [decodedId, favoriteId] = this._decodeId(id);
    const position = favoriteId % BASE_DELTA;
    let inputs = await this._master.getInputList().get(undefined, 0, +Infinity);

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


    // create a deep copy
    inputs = JSON.parse(JSON.stringify(inputs));

    let item = inputs.items[position];
    item.image = icons[icon];
    await this._master.getInputList().replace(position, item);

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
    if (!this._master)
        return this._emptyCommand(url, [{scanning: 0}]);

    let status = await this._master.scanStatus();

    return this._emptyCommand(url, [{scanning: +status}]);
  }

  async _audioCfgPropsUpdateLevel(url) {
    return this._emptyCommand(url, []);
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
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    if (volume) {
      await zone.defaultVolume(+volume);
    }

    return this._emptyCommand(url, []);
  }

  async _audioCfgMaxVolume(url) {
    const [, , , zoneId, volume] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    if (volume) {
      await zone.maxVolume(+volume);
    }

    return this._emptyCommand(url, []);
  }

  async _audioCfgEventVolumes(url) {
    const [, , , zoneId, volumeString] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    //TODO unclear what to do here, as the values are saved on the miniserver
    //     and we don't know how to get the inital values.

    return this._emptyCommand(url, []);
  }

  async _audioCfgAudioDelay(url) {
    const [, , , zoneId, delay] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    var newDelay = 0
    if (!delay)
        newDelay = zone.getAudioDelay();
    else
        zone.audioDelay(delay);

    return this._emptyCommand(url, [{ "audio_delay": newDelay }]);
  }

  async _audioCfgReady(url) {
    this._pushHwEvent(0);
    return this._emptyCommand(url, {"session":547541322864});
  }

  async _audioCfgReboot(url) {
    this._pushRebootEvent();
    this._master.reboot();
    return this._emptyCommand(url, "reboot");
  }

  async _audioCfgDiagnosis(url) {
    var diagObj = await this._master.diagnosis();

    // Add some meaningful information here
    /*diagObj["msg"] = {
        musicJSON : this.musicJSON,
        musicCRC: this.musicCRC
    }*/

    return this._emptyCommand(url, diagObj);
  }

  async _audioCfgIdentifyAcoustic(url) {
    const [, , , mac, , outputs] = url.split('/');

    var zones = []
    var outs = outputs.split(',');
    for (var i in outs) {
        var id = mac + "#" + outs[i];
        console.log(this._lc, "Searching for", id);

        for (var ms in this.musicJSON) {
            var msObj = this.musicJSON[ms];
            msObj = msObj[Object.keys(msObj)[0]];
            for (var playeridx in msObj.players) {
                var player = msObj.players[playeridx];
                for (var outidx in player.outputs) {
                    for (var ch in player.outputs[outidx].channels) {
                        if (player.outputs[outidx].channels[ch].id == id) {
                            zones.push(player.playerid);
                            break;
                        }
                    }
                }
            }
        }
    }

    this._master.playAcousticFeedback(zones);

    return this._emptyCommand(url, []);
  }

  async _audioCfgIdentify(url) {
    return this._emptyCommand(url, []);
  }

  async _audioCfgGetConfig(url) {
    return this._emptyCommand(url, {"crc32":this.musicCRC,"extensions":this.extensions});
  }

  async _audioCfgSetConfig(url) {
    const [, , ,encoded_data] = url.split('/');
    const buff = Buffer.from(encoded_data, 'base64');
    const str = buff.toString('utf-8');
    this.musicJSON = JSON.parse(str);
    this.musicCRC = crc32(str).toString(16);
    fs.writeFileSync(".music.json", str);

    return this._emptyCommand(url, {"crc32":this.musicCRC,"extensions":this.extensions});
  }

  async _audioCfgMiniservertime(url) {
    return this._emptyCommand(url, true);
  }

  async _audioCfgSpeakerType(url) {
    // base64 encoded string which contains the following:
    // {"speakers":[{"id":"504F94FF1BB4#1","speakerType":0},{"id":"504F94FF1BB4#3","speakerType":0},..]}
    return this._emptyCommand(url, []);
  }

  async _audioCfgVolumes(url) {
    const [, , ,encoded_data] = url.split('/');
    const buff = Buffer.from(encoded_data, 'base64');
    this.volumesJSON = JSON.parse(buff.toString('utf-8'));

    console.log(this._lc, "VOLUMES:", this.volumesJSON);

    for (var i in this.volumesJSON.players) {
        const alarms = this.volumesJSON.players[i];
        const zone =  this._zones[alarms.playerid];
        if (!zone)
            continue;

        await zone.allVolumes({
            default: alarms.default,
            general: alarms.alarm,
            fire: alarms.fire,
            bell: alarms.bell,
            clock: alarms.buzzer,
            tts: alarms.tts
        })
    }

    return this._emptyCommand(url, []);
  }

  async _audioCfgPlayername(url) {
    const [, , ,encoded_data] = url.split('/');
    const buff = Buffer.from(encoded_data, 'base64');
    const playerJSON = JSON.parse(buff.toString('utf-8'));

    console.log(this._lc, "PLAYER NAMES:", playerJSON);

    // Search for all Players which are part of the music.json
    // Identify them by name
    const players = playerJSON.players;
    for(var i in players) {
        const playerId = players[i].playerid;
        const playerName = players[i].name;
        const volumes = this.volumesJSON.players[i];
        console.log(this._lc, "Found Player:", playerName, playerId);
        console.log(this._lc, this._config)
        if (config.zone_map[playerName]) {
            console.log(this._lc, "Adding Zone:", playerName, "with mac:", config.zone_map[playerName]);
            this._zones[playerId] = new MusicZone(this, playerName , this);
            if (playerName == this.masterZoneName) {
                console.log(this._lc, "Adding Zone:", playerName, "as master zone");
                this._masterZone = this._zones[playerId];
            }

            await this._zones[playerId].allVolumes({
                default: volumes.default,
                general: volumes.alarm,
                fire: volumes.fire,
                bell: volumes.bell,
                clock: volumes.buzzer,
                tts: volumes.tts
            })
        } else {
            console.log(this._lc, "Adding UNCONFIGURED Zone:", playerName);
            this._zones[playerId] = new MusicZone(this, playerName , this);
        }
    }
    this._master = new MusicMaster(this);

    return this._emptyCommand(url, []);
  }

  async _audioCfgPlayeropts(url) {
    return this._emptyCommand(url, "ok");
  }

  async _playGroupedTTS(url) {
    const [, , , zones, input] = url.split('/');
    const [language, text] = input.split('|');

    var newZoneVols = [];
    var zones_ids = zones.split(',');
    for (var i in zones_ids) {
        var volObj = this.volumesJSON.players.find(element => element.playerid == zones_ids[i]);

        var volume = volObj.tts;
        newZoneVols.push(zones_ids[i] + "~" + volume)
    }

    await this._master.playGroupedTTS(
      newZoneVols,
      language,
      text,
    );

    return this._emptyCommand(url, []);
  }

  async _playGroupedAlarm(url) {
    const [, , type, input, zones] = url.split('/');

    const alarms = {
      alarm: 'general',
      bell: 'bell',
      firealarm: 'fire',
      wecker: 'clock',
      buzzer: 'clock'
    };

    //musicserver: audio/grouped/alarm/1~45,2~40,3~55,4~50,5~60,6~30,7~50,12~90
    //audioserver: audio/grouped/alarm/3,4,5,6
    //both: audio/grouped/alarm/stop/3,4,5,6
    if (zones == undefined) {
        var newZoneVols = [];
        if (config.type == "audioserver") {
            var zones_ids = input.split(',');
            for (var i in zones_ids) {
                var volObj = this.volumesJSON.players.find(element => element.playerid == zones_ids[i]);

                var volume = volObj[type];
                newZoneVols.push(zones_ids[i] + "~" + volume)
            }
        } else {
            newZoneVols = input.split(",");
        }

        await this._master.playGroupedAlarm(
          alarms[type],
          newZoneVols,
        );
    } else {
        await this._master.stopGroupedAlarm(
          alarms[type],
          zones,
        );
    }

    return this._emptyCommand(url, []);
  }
  
  async _audioCfgDynamicGroup(url) {
    const [, , , , id, zones_string] = url.split('/');
    const zones = zones_string.split(',');

    if (id == "new") {
        const zoneId = zones[0];
        zones.splice(0, 1);

        const zone = this._zones[zoneId];
        if (!zone) {
          return this._emptyCommand(url, []);
        }

        await zone.sync(zones);
    } else {
        const syncGroups = this._master.getSyncGroups();

        if (zones_string) {
            // First unsync all zones of the group
            for (const zoneId in syncGroups[+id][0]) {
                const zone = this._zones[zoneId];
                await zone.unSync();
            }
            // Then sync the new group
            const zone = this._zones[zones[0]];
            zones.splice(0, 1);
            await zone.sync(zones);
        } else {
            for (var i in syncGroups[+id]) {
                await this._zones[syncGroups[+id][i]].unSync();
            }
        }
    }

    return this._response(url, 'dgroup_update', {});
  }

  async _playGroupedPause(url) {
    const [, , ,zones_string] = url.split('/');
    const zones = zones_string.split(',');

    for (var zoneIndex in zones) {
        const zone = this._zones[zones[zoneIndex]];
        if (!zone) {
          console.log(this._lc, "No Zone with id", zones[zoneIndex]);
          return this._emptyCommand(url, []);
        }

        zone.pause();
    }

    return this._emptyCommand(url, []);
  }

  async _playGroupedPlay(url) {
    const [, , ,zones_string] = url.split('/');
    const zones = zones_string.split(',');

    for (var zoneIndex in zones) {
        const zone = this._zones[zones[zoneIndex]];
        if (!zone) {
          console.log(this._lc, "No Zone with id", zones[zoneIndex]);
          return this._emptyCommand(url, []);
        }

        zone.resume();
    }

    return this._emptyCommand(url, []);
  }

  async _audioMasterVolume(url) {
    const [, playerZoneId, , volume] = url.split('/');

    const playerZone = this._zones[playerZoneId];
    if (!playerZone) {
      console.log(this._lc, "No Zone with id", playerZoneId);
      return this._emptyCommand(url, []);
    }

    // We need to calculate the delta in order to know how
    // the volume of each zone needs to be changed.

    var has_playing_zones = false;
    var force_play = false;
    var volume_delta = 0;
    while (!has_playing_zones) {
        // If no zone in the group is currently playing we resume the
        // zone which was used in the command
        if (force_play) {
            console.log(this._lc, "Resuming playback")
            await playerZone.resume();
        }

        const syncGroups = this._master.getSyncGroups();
        for (var groupId in syncGroups) {
            if (syncGroups[groupId].includes(+playerZoneId)) {
                for (var syncZoneIndex in syncGroups[groupId]) {
                    let syncZoneId = syncGroups[groupId][syncZoneIndex]

                    const zone = this._zones[syncZoneId];
                    if (!zone) {
                      console.log(this._lc, "No Zone with id", syncZoneId);
                      return this._emptyCommand(url, []);
                    }

                    if (force_play || zone.getMode() == "play") {
                        has_playing_zones = true;
                        // The first zone is the master of the groupe and we use that
                        // for delta calculation
                        // If it is not playing, we use the next one
                        if (volume_delta == 0) {
                            volume_delta = volume - zone.getVolume();
                            console.log(this._lc, "Calculated Volume Delta using first Zone:", volume_delta)
                        }

                        console.log(this._lc, "Changing volume for Zone:", zone._id)
                        await zone.volume(zone.getVolume() + volume_delta);
                    }
                }

                if (has_playing_zones)
                    this._pushMasterVolumeChangedEvent(groupId, volume)
            }
        }

        // If we no zone is playing, we start all zones
        if (!has_playing_zones) {
            force_play = true;
        }
    }

    return this._response(url, 'mastervolume', {});
  }

  async _audioAlarm(url) {
    const [, zoneId, type, volume] = url.split('/');
    const zone = this._zones[zoneId];

    const alarms = {
      alarm: 'general',
      bell: 'bell',
      firealarm: 'fire',
      wecker: 'clock',
      buzzer: 'clock'
    };

    await zone.alarm(
      alarms[type],
      volume === undefined ? zone.getVolume() : +volume,
    );

    return this._audioCfgGetPlayersDetails('audio/cfg/getplayersdetails');
  }

  async _audioGetStatus(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, [{playerid: +zoneId, title: "ZONE NOT CONFIGURED IN MSG"}]);
    }
    return this._emptyCommand(url, [this._getAudioState(zone)]);
  }

  async _audioGetQueue(url) {
    const [, zoneId, , start, length] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    if (+zoneId > 0) {
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
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    return this._response(url, 'identifysource', [this._getAudioState(zone)]);
  }

  async _audioLibraryPlay(url) {
    const [, zoneId, , , id] = url.split('/');
    const zone = this._zones[zoneId];
    const [decodedId, favoriteId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.play(decodedId, favoriteId);

    return this._emptyCommand(url, []);
  }

  async _audioLineIn(url) {
    const [, zoneId, id] = url.split('/');
    const zone = this._zones[zoneId];
    const [decodedId, favoriteId] = this._decodeId(id.replace(/^linein/, ''));
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.play(decodedId, favoriteId);

    return this._emptyCommand(url, []);
  }

  async _audioOff(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.power('off');

    return this._emptyCommand(url, []);
  }

  async _audioOn(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.power('on');

    return this._emptyCommand(url, []);
  }

  async _audioSleep(url) {
    const [, zoneId, ,duration] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.sleep(+duration);

    return this._emptyCommand(url, []);
  }

  async _audioPause(url) {
    const [, zoneId, , volume] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.pause();

    return this._emptyCommand(url, []);
  }

  async _audioStop(url) {
    const [, zoneId, , volume] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.stop();

    return this._emptyCommand(url, []);
  }

  async _audioPlay(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

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

  async _audioPlayAlsaLoop(url) {
    const [, zoneId, , , hw, delay] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    zone.playAlsaLoop(hw, delay);

    return this._emptyCommand(url, []);
  }

  async _audioPlayUrl(url) {
    const [, zoneId, , ...lastArg] = url.split('/');
    let id = lastArg.join('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

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

  async _audioAddUrl(url) {
    const [,zoneId, ,id] = url.split('/');
    const zone = this._zones[zoneId];
    const [decodedId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    const {total} = await zone.getQueueList().get(undefined, 0, 0);

    await zone.getQueueList().insert(total, {
      id: decodedId,
      title: null,
      image: null,
    });

    return this._emptyCommand(url, []);
  }

  async _audioInsertUrl(url) {
    const [,zoneId, ,id] = url.split('/');
    const zone = this._zones[zoneId];
    const [decodedId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

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

  async _audioPlaylist(url) {
    const [, zoneId, , , id] = url.split('/');
    const zone = this._zones[zoneId];
    const [decodedId, favoriteId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.play(decodedId, favoriteId);

    return this._emptyCommand(url, []);
  }

  async _audioPosition(url) {
    const [, zoneId, , time] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.time(+time * 1000);

    return this._emptyCommand(url, []);
  }

  _audioQueueMinus(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    if (zone.getTime() < 3000) {
      zone.previous();
    } else {
      zone.time(0);
    }

    return this._emptyCommand(url, []);
  }

  _audioQueuePlus(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    zone.next();

    return this._emptyCommand(url, []);
  }

  async _audioQueueIndex(url) {
    const [, zoneId, , index] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.setCurrentIndex(index);

    return this._emptyCommand(url, []);
  }

  async _audioQueuePlay(url) {
    const [, zoneId, , , index] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.setCurrentIndex(index);

    return this._emptyCommand(url, []);
  }

  async _audioQueueDelete(url) {
    const [, zoneId, , position] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.getQueueList().delete(+position, 1);
    if (!zone.getQueueList().canSendEvents)
        this._pushQueueEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioQueueRemove(url) {
    const [, zoneId, , , position] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.getQueueList().delete(+position, 1);
    if (!zone.getQueueList().canSendEvents)
        this._pushQueueEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioQueueClear(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.getQueueList().clear();
    if (!zone.getQueueList().canSendEvents)
        this._pushQueueEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioQueueMove(url) {
    const [, zoneId, , position, destination] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.getQueueList().move(+position, +destination);
    if (!zone.getQueueList().canSendEvents)
       this._pushQueueEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioQueueMoveBefore(url) {
    let [, zoneId, , , position, , destination] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    if (destination == undefined) {
        const {total} = await zone.getQueueList().get(undefined, 0, 0);
        destination = total - 1;
    }

    await zone.getQueueList().move(+position, +destination);
    if (!zone.getQueueList().canSendEvents)
       this._pushQueueEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioQueueAdd(url) {
    const [, zoneId, , id] = url.split('/');
    const zone = this._zones[zoneId];
    const [decodedId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

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
    const zone = this._zones[zoneId];
    const [decodedId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

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
    const zone = this._zones[zoneId];
    const repeatModes = {0: 0, 1: 2, 3: 1};
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    zone.repeat(repeatModes[repeatMode]);

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavDelete(url) {
    const [, zoneId, , , position, id, title] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.getFavoritesList().delete(+position - 1, 1);
    if (!zone.getFavoritesList().canSendEvents)
        this._pushRoomFavChangedEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavPlay(url) {
    const [, zoneId, , , position] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    const favorites = await zone.getFavoritesList().get(undefined, 0, 50);
    const id = favorites.items[+position - 1].id;

    await zone.play(id, BASE_FAVORITE_ZONE + (+position - 1));

    this._pushRoomFavEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavPlayId(url) {
    const [, zoneId, , , id] = url.split('/');
    const zone = this._zones[zoneId];
    const [decodedId, favoriteId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.play(decodedId, favoriteId);

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavPlayByName(url) {
    const [, id, , ,position] = url.split('/');

    // id could be the zone name or the mac addresss
    let zone_mac = id;
    if (config.zone_map[id])
        zone_mac = config.zone_map[id];

    // find the zone with the mac and play
    for (var i in this._zones) {
        if (this._zones[i]._zone_mac != zone_mac)
            continue;

        const zone = this._zones[i];
        const favorites = await zone.getFavoritesList().get(undefined, 0, 50);
        console.log(this._lc, favorites, +position - 1, favorites.items[+position - 1]);
        const favid = favorites.items[+position - 1].id;

        await zone.play(favid, BASE_FAVORITE_ZONE + (+position - 1));

        this._pushRoomFavEvents([zone]);
        return this._emptyCommand(url, []);
    }

    return this._emptyCommand(url, "No such zone");
  }

  async _audioRoomFavPlus(url) {
    const [, zoneId] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    var favoriteId = zone.getFavoriteId();
    if (zone.getMode() === 'stop') {
        //If the playqueue is empty start the first room favorite
        if (zone.getTrack().id == "") {
            favoriteId = 0;
        } else {
            await zone.play(null, 0);
            return this._emptyCommand(url, []);
        }
    }

    const favorites = await zone.getFavoritesList().get(undefined, 0, 8);

    let position =
      BASE_DELTA * Math.floor(favoriteId / BASE_DELTA) === BASE_FAVORITE_ZONE
        ? (favoriteId % BASE_FAVORITE_ZONE) + 1
        : 0;

    for (; position < 16; position++) {
      if (favorites.items[position % 8] &&
          favorites.items[position % 8].id) {
        // On the audioserver we want to iterate only over all items with plus
        if (config.type == "audioserver") {
            if (favorites.items[position % 8].plus) {
                position = position % 8;
                break;
            }
        } else {
            position = position % 8;
            break;
        }
      }
    }

    const id = favorites.items[position].id;

    await zone.playRoomFav(id, BASE_FAVORITE_ZONE + position, favorites.items[position].title);

    this._pushRoomFavEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavSavePath(url) {
    const [, zoneId, , , position, id, title] = url.split('/');
    const zone = this._zones[zoneId];
    const [decodedId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

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

  async _audioRoomFavsAdd(url) {
    const [, , , zoneId, , title, ...lastArg] = url.split('/');
    const zone = this._zones[zoneId];
    const id = lastArg.join('/')
    let decodedId;
    console.log(this._lc, id);

    try {
        [decodedId] = this._decodeId(id);
    } catch(e) {
        decodedId = id;
    }

    if (!zone) {
      return this._emptyCommand(url, []);
    }

    const item = {
      id: decodedId,
      title,
      image: this._imageStore[decodedId],
    };

    const {total} = await zone.getFavoritesList().get(undefined, 0, 0);

    await zone.getFavoritesList().insert(total, item);
    if (!zone.getFavoritesList().canSendEvents)
        this._pushRoomFavChangedEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavsReorder(url) {
    const [, , , zoneId, , config] = url.split('/');
    const zone = this._zones[zoneId];
    const ids = config.split(',');
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    var favs = await zone.getFavoritesList().get(undefined, 0, 100);
    // create a deep copy
    favs = JSON.parse(JSON.stringify(favs));
    var emptyFavs = 0;

    for (var i=0; i < ids.length; i++) {
        const [decodedId, favoriteId] = this._decodeId(ids[i]);
        const index = favoriteId % 1000000;

        console.log(this._lc, "NEW ORDER: " + decodedId + " " + index)

        const item = favs.items[index];

        // Check whether the original position was empty and search for the next occupied spot
        while (favs.items[i + emptyFavs].id == undefined)
            emptyFavs++;

        await zone.getFavoritesList().replace(i + emptyFavs, item)
    }

    if (!zone.getFavoritesList().canSendEvents)
        this._pushRoomFavChangedEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavsDelete(url) {
    const [, , , zoneId, , id] = url.split('/');
    const zone = this._zones[zoneId];
    const [decodedId, favoriteId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    const index = favoriteId % 1000000;

    await zone.getFavoritesList().delete(index, 1);

    if (!zone.getFavoritesList().canSendEvents)
        this._pushRoomFavChangedEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavsSetPlus(url) {
    const [, , , zoneId, , id, setplus] = url.split('/');
    const zone = this._zones[zoneId];
    const [decodedId, favoriteId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    const index = favoriteId % 1000000;

    var favs = await zone.getFavoritesList().get(undefined, 0, 100);
    // create a deep copy
    favs = JSON.parse(JSON.stringify(favs));

    let item = favs.items[index];
    item.plus = (setplus == "1");
    await zone.getFavoritesList().replace(index, item);

    if (!zone.getFavoritesList().canSendEvents)
        this._pushRoomFavChangedEvents([zone]);

    return this._emptyCommand(url, []);
  }

  async _audioRoomFavSaveExternalId(url) {
    const [, zoneId, , , position, ,id, title] = url.split('/');
    const zone = this._zones[zoneId];
    const [decodedId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

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

    const srcZone = this._zones[source];
    const destZone = this._zones[destination];
    if (!srcZone || !destZone) {
      this._emptyCommand(url, []);
    }

    var data = await srcZone.getFavoritesList().get(undefined, 0, 100);
    var destData = await destZone.getFavoritesList().get(undefined, 0, 100);

    for (var i=0; i < data.total; i++) {
        await destZone.getFavoritesList().replace(i, data.items[i]);
    }
    // Delete the remaining favorites in the destination;
    await destZone.getFavoritesList().delete(data.total, destData.total - data.total);

    return this._emptyCommand(url, []);
  }

  async _audioServicePlay(url) {
    const [, zoneId, , , account, id, noShuffle] = url.split('/');
    const zone = this._zones[zoneId];
    const [decodedId, favoriteId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.switchSpotifyAccount(account);

    if (noShuffle) {
        await zone.shuffle(0);
    } else {
        await zone.shuffle(1);
    }

    await zone.play(decodedId, favoriteId);

    return this._emptyCommand(url, []);
  }

  async _audioServicePlayInsert(url) {
    const [, zoneId, , , account, id] = url.split('/');
    const zone = this._zones[zoneId];
    const [decodedId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.switchSpotifyAccount(account);

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
    const [, zoneId, , , account, id] = url.split('/');
    const zone = this._zones[zoneId];
    const [decodedId] = this._decodeId(id);
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    await zone.switchSpotifyAccount(account);

    const {total} = await zone.getQueueList().get(undefined, 0, 0);

    await zone.getQueueList().insert(total, {
      id: decodedId,
      title: null,
      image: null,
    });

    return this._emptyCommand(url, []);
  }

  _audioShuffle(url) {
    let [, zoneId, , shuffle] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    if (!shuffle) {
        shuffle = +(zone.getShuffle()) + 1;
        if (shuffle > 2)
            shuffle = 0;
    }

    zone.shuffle(+shuffle);

    return this._emptyCommand(url, []);
  }

  async _audioSync(url) {
    const [, zoneId, , ...zones] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    zone.sync(zones);

    return this._emptyCommand(url, []);
  }

  async _audioUnSync(url) {
    const [, zoneId,] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    zone.unSync();

    return this._emptyCommand(url, []);
  }

  async _audioUnSyncMulti(url) {
    const [, , , ...zones] = url.split('/');

    for (var i in zones) {
        const zone = this._zones[+zones[i] - 1];
        if (!zone)
          continue;
        zone.unSync();
    }

    return this._emptyCommand(url, []);
  }

  async _audioVolume(url) {
    const [, zoneId, , volume] = url.split('/');
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }
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
    const zone = this._zones[zoneId];
    if (!zone) {
      return this._emptyCommand(url, []);
    }

    zone.tts(language, text, volume);

    return this._emptyCommand(url, []);
  }

  async _audioUpload(url, data) {
    const [, , , , , filename] = url.split('/');

    fs.writeFileSync(config.uploadPath + '/' + filename, data);

    return this._emptyCommand(url, []);
  }

  async _playUploadedFile(url) {
    const [, , , filename, zones] = url.split('/');

    var newZoneVols = [];
    var zones_ids = zones.split(',');
    for (var i in zones_ids) {
        var volObj = this.volumesJSON.players.find(element => element.playerid == zones_ids[i]);

        var volume = volObj.tts;
        newZoneVols.push(zones_ids[i] + "~" + volume)
    }

    this._master.playUploadedFile(config.uploadPlaybackPath + '/' + filename, newZoneVols);

    return this._emptyCommand(url, []);
  }

  async _secureHello(url) {
    const [, , id, pub_key] = url.split('/');
    return '{"command":"secure/hello","error":0,"public_key":"' + pub_key + '"}'
    //return '{"command":"secure/hello","error":0,"public_key":"LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUZyakNDQTVhZ0F3SUJBZ0lKQU5ORStBQ2hGMS9aTUEwR0NTcUdTSWIzRFFFQkN3VUFNR014Q3pBSkJnTlYKQkFZVEFrRlVNUkF3RGdZRFZRUUlEQWRCZFhOMGNtbGhNU0F3SGdZRFZRUUtEQmRNYjNodmJtVWdSV3hsWTNSeQpiMjVwWTNNZ1IyMWlTREVnTUI0R0ExVUVBd3dYY205dmRDMWpZUzVzYjNodmJtVmpiRzkxWkM1amIyMHdJQmNOCk1UZ3dOekEyTURZeE5qQTRXaGdQTWpFeE9EQTJNVEl3TmpFMk1EaGFNR014Q3pBSkJnTlZCQVlUQWtGVU1SQXcKRGdZRFZRUUlEQWRCZFhOMGNtbGhNU0F3SGdZRFZRUUtEQmRNYjNodmJtVWdSV3hsWTNSeWIyNXBZM01nUjIxaQpTREVnTUI0R0ExVUVBd3dYY205dmRDMWpZUzVzYjNodmJtVmpiRzkxWkM1amIyMHdnZ0lpTUEwR0NTcUdTSWIzCkRRRUJBUVVBQTRJQ0R3QXdnZ0lLQW9JQ0FRQ29RTThlSlRibmpTaWZOWGtzcjNtRzNwNjRuS0hjWjFyb1l6Tk4KRTlDaUVMOWJ0MlpGNTlUbDBYN2xwNFNyNmQ2YVBmK1R0TlRmNzhKanl6UnNWdWdBNGJ5REJWM0c1YVNSVWtJbQp6U1o2cEFhZVNjN2J2TkJDZThBdzdXNVhBYkdHRGwzenYrSnhjbDZwTnNKL2hBZkNaSzNTaGQyWlZwdG0wT2ZiCkRQSzJ3Q0k0cjRCWjJ3UXdMZXBQU0Y3RVB4UTZsL3drZmVkeGdOc0JCZktPaTVFRVA2L2N0RTcxWUhrQklRQk4KMjFnVndNTzFEU1NkSzYxcTNMMndaZnQwZEpFZW1PMFMxQlNlbUpScmZ6QXo3cWYvUUVPdkNTOTBndTVWOWwyRApzcnBDZ252NmYzdHFUVEdDS0w5ajdMNWdrNDJDR2poR1JHVWI2ZFI0cHo3R3A2OWVGcldvNjlaNGtLa0l3ZURQCmsrREI0NFRRMFpCU1JPOEZtWGswY0pmM05JYS9sdlRaWUptUXJYUEdzQjFhSUFxSkZ1V2FnbHVJUThHdHd0QjgKRWR2VDlzSG5aOVArVzk5U2VGNGNDSVU0MlA0R09FNUVvVlI4d014bWJmMjdiZG9KSlNkelQ3N1NKRTNtYWhpUAoxemNGaUtYcUMzMmJZZDF5aFpJaVVWYm9Oa0xrTmJaMmtQZ1p4SE9iQkJqZ0tCOUxmQmtteWJXQ1o5Q0pJOEExCkpkM29WMnU5L3hObVk4MzhzckU0NHZQM1Nqd3BmalBuMGFXOGkzbG9OTVljcHN5R2owZ2JJQXhzRnhXQTh3bmsKa2hJeHZXdFhjVWpTYkpwd2hmOXB2NHZjcURIMThGMlV6cjNQbVlMYTIvMThsMmQxOGwvRDVBeXpKck5BRnVVWgo0cytXaHdJREFRQUJvMk13WVRBZEJnTlZIUTRFRmdRVWtESWhCVlh1Zm5yblc2SmJyaTl0bWdERlhYMHdId1lEClZSMGpCQmd3Rm9BVWtESWhCVlh1Zm5yblc2SmJyaTl0bWdERlhYMHdEd1lEVlIwVEFRSC9CQVV3QXdFQi96QU8KQmdOVkhROEJBZjhFQkFNQ0FZWXdEUVlKS29aSWh2Y05BUUVMQlFBRGdnSUJBR21UYUJLOE5LWFNYTUM3cUk2YgpqSGZBeEhTRWtwSFhER0kxMWk0UnFBdldvVERBWHprV05KL0RVSWx6dWRwNFFhVTIwNEIranlpWlZ3VlAvUGhJCmFjTzRBbGFYVTBwOWFleW53OFY0ZlVNSE9yYjRNWDM0ZVBpTDUxZnVubFZCUzBxaGl5aEJRRlRvT295THNMYkkKZUpYYU9jbVlhbTdrU3hybzZXY3hway9sSFhMVnlWVWs1RGZ6Rk80RERpM2Q5RDJYSng0SHUwZWIzQmN2bzl6UQpQN255Q21yNWJaMG10anMxMVhKMUFFWk9ydmRMZFRnL1NTQnNYVHdUSGJ4UTlEUU5nWkhGUUxRaE10VG9KeXB4CllEUVdZbzJUbGcvMTRXdzd3VFlvSStjZzdCRXUzcnZKRjhBbU1tTHIwcmk5NlZma0hsWDdnZ1NIZ3BIQkh5TUQKSkd0ZjRiSld5TzZVcmNqY013aVY0YytmeGllbTdBUkUwUllFeE5GS3UrbEdMZ2tQbXlpdzM5WkRRQ0hidlYycgo0dm5KSzRwWDNBejFCekIyY04rUTZTYnQ4alY1a1E1dlRZM0tCQ0crK2lGR3YrRHdreW5GR1ZwTldTK3dXTzNLCmtlZldtSUNBbkVHWENjaFVNVlJ3bllBR2IyTG9aVUR2SHQ2OHpESm5pS2FBaDFaaEIwM1VRRU9HaWlSNjhyMm0KWkhoVXlLKzlsbldrMVZRMlJsSk82eTRpRlVPL1Vtd2luc0FETUlSSU0zMCtZMXA4ZXRKWkJZYW12S2lZVjRuawpJMjRBYXFKZDlqdUtoNVR2TEc1RWhLbDdPR1FJUkVVeDgzalJwQzBIdjRNUStEQWFUTGMrOGJ4QnpBeGp5bE84CmtvMHpYUm9ZN08vK1pLVlFTNEJrWTA4SAotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCi0tLS0tQkVHSU4gQ0VSVElGSUNBVEUtLS0tLQpNSUlGeURDQ0E3Q2dBd0lCQWdJQ0VBUXdEUVlKS29aSWh2Y05BUUVMQlFBd1l6RUxNQWtHQTFVRUJoTUNRVlF4CkVEQU9CZ05WQkFnTUIwRjFjM1J5YVdFeElEQWVCZ05WQkFvTUYweHZlRzl1WlNCRmJHVmpkSEp2Ym1samN5QkgKYldKSU1TQXdIZ1lEVlFRRERCZHliMjkwTFdOaExteHZlRzl1WldOc2IzVmtMbU52YlRBZ0Z3MHhPREE0TVRjdwpOekkxTXpaYUdBOHlNVEU0TURjeU5EQTNNalV6Tmxvd2dZQXhDekFKQmdOVkJBWVRBa0ZVTVJBd0RnWURWUVFJCkRBZEJkWE4wY21saE1TQXdIZ1lEVlFRS0RCZE1iM2h2Ym1VZ1JXeGxZM1J5YjI1cFkzTWdSMjFpU0RFVU1CSUcKQTFVRUN3d0xiWFZ6YVdOelpYSjJaWEl4SnpBbEJnTlZCQU1NSG0xMWMybGpjMlZ5ZG1WeUxXTmhMbXh2ZUc5dQpaV05zYjNWa0xtTnZiVENDQWlJd0RRWUpLb1pJaHZjTkFRRUJCUUFEZ2dJUEFEQ0NBZ29DZ2dJQkFOeXZpaXg3Ci9KQ21ibm81ZW5VL2FCSFA4RjFGcExZQ2JoRnlydHVVYnlJeFUxakEwQkgrdmozVkNBZ0NkZHNFRjdJS2prQ1cKUmlmbTVlWWplWHQybnNidktUQkh4SmJ3WmI0VmNOSEJUejRNYnVOZ0FBTUpyTW1UWm15aGo1RVdSZWFQcU5KbgpGWEhiUnJ0aHVMT1F6cC9LRFgxMjJxQnllUUVPZENqR0ZQa2VFZlhhWGQ5WVJ3MEl5YUJ6UTZFWllzbjlhSFRvCldwVzE1b1RGN1ZwZHZlQm93eHJqdkw0UEw1YVcvcXNDVjVLanQ5Vzd1bFVWMVA2RXVEVmI3Mml1UWdVNGxORVAKVzBhZ2VGR2xDbWlvNXNJbldlTTVRM1N4WDN3TUhVV25XbnVoeFVpQmY5UHUyekRzZUp3cTNjNGdIcmdvSko5bwp0ZFVVSldRRUw5aVpuZWhiWjZEc1JjbmdsT0Y2SVpQTGZrVkhKNkFTODBqay94bnk2L0pqRlRocDRTdVV6Zmt0CjRic1hMNEYzL1ArQnRQaVZaVEp2ZmM4djNwYnRELzlFSmtiQzRKejc4Wk5iRnlEellDMi93ZVVrUldka0k5cEEKTjFiZ3VNZ1k0cFh3Y09iQnl0aDVuTXRodzc3ZFBrRlAwemdtVkZnbVFNZlVEN0QzbVV6UWd0VGdlcGFZYXZ6NwpoOEJmU2pTbXpsQmordHREN2dFcFRJL2J2b0xrVHF5d1ZiM1F1a1NyUDFKK0N4dE5tbXJmVTNCcTRYRkxDam1UCmNtemlpcjduR1Z4UTVTQmVkdDlQZlB1aHNxL2ZBa2lkU2dWRlNrSkExUVA5TUVaMmMybXc4NXcvVU5hUkM4NnQKOG5CMkdqU3dHZVR5OW80UUJkL0R4SmUzT082VFpNVWJWK1pYQWdNQkFBR2paakJrTUIwR0ExVWREZ1FXQkJTWgoyaHZrcHhqTWNoWk9ZK3gyS0RsMkpjYWM2ekFmQmdOVkhTTUVHREFXZ0JTUU1pRUZWZTUrZXVkYm9sdXVMMjJhCkFNVmRmVEFTQmdOVkhSTUJBZjhFQ0RBR0FRSC9BZ0VBTUE0R0ExVWREd0VCL3dRRUF3SUJoakFOQmdrcWhraUcKOXcwQkFRc0ZBQU9DQWdFQU81dWdLaDBiczlSQW1RK21hZkZKa0JYNXkwS0VLanpCK3VCKzV6MjJQbTBVT2VHMwo5TDVHWjJsMGRwODBDV2hTOXM2MU9kaEhMdHNUU2RCNU04ZEErbnU2eGZlMXJ0Z0l1Z0pyTFVlYWk4QXF1bUdmCnQzSVFvQldMWjVzaFIvMHhHalVYV2JUSlQzNjhtVmZCc3Mva1ZuS2M1K01EUmFVdUxYOUdqaGRBbFNRaVI5QXIKT1ZpZWMwQTJQS3NzQlZzN2JaaG5IUmlKdU4xSjgxZk95Q0Jud045V1l5dTRVRkgrTWJZWGNBQUVmWnVPSEpRQQpwQkZXTlJIUGdSNWdzNTFnc3Z3ckpTYzdmbERsS2tPbkhxNm1vRmgvWGFlU2wzU1psQjAvd0xaeFZoVFFETEprCnpvQ1MrcVROSFlFMUgrbTJ0V0h3M3BXWmFLUk0yTURsank5MjdMcmhYdU00U3hBUERrZTROOGNPSHZlODhVMm4KamlMc3BkcTJLbnMyTkFmM1dmWWxiSDNqV1hWVUdUTGFlZGh0ckxjMnI3L1VuSWFzODc4cjhxVGxLQUUvcjBHWQozajRnZUZlNE1WRjdKNndIL3VqeXdsZHZOSUtWd0hLU0pPTGRaZ1h0Tk1mRmV0dWZUTkZROGxyeDFpMy82c2lWCkdVZ1Z2WS9jY002eGN6dlA3RnA3SFF2L3BmTElFMmdjMGQzVlpSR3F0dllPSXdhVmJyVGlybS9KQUR5N3hnMVQKd1NlTzc5dUpIOVNNMXlBVm0wdk1PSkc3RjRpVnVjVk5kZmpkbVFNdDVUdEFNNjA2RmNSeHVKU2lmS1JGNDVpNgo3aXRob0dQbXFMQmM4M3ZZVldGUmNwbnpuUkFtQ3c0elV0TzRVSDU3WnZoT25waUdxbytSQUhnRXVqVT0KLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQotLS0tLUJFR0lOIENFUlRJRklDQVRFLS0tLS0NCk1JSUdtRENDQklDZ0F3SUJBZ0lDSUFVd0RRWUpLb1pJaHZjTkFRRUxCUUF3Z1lBeEN6QUpCZ05WQkFZVEFrRlUNCk1SQXdEZ1lEVlFRSURBZEJkWE4wY21saE1TQXdIZ1lEVlFRS0RCZE1iM2h2Ym1VZ1JXeGxZM1J5YjI1cFkzTWcNClIyMWlTREVVTUJJR0ExVUVDd3dMYlhWemFXTnpaWEoyWlhJeEp6QWxCZ05WQkFNTUhtMTFjMmxqYzJWeWRtVnkNCkxXTmhMbXh2ZUc5dVpXTnNiM1ZrTG1OdmJUQWlHQTh5TURJd01Ea3lPREF3TURBd01Gb1lEekl4TWpBd09UQTANCk1EUTBNekF5V2pCZk1Rc3dDUVlEVlFRR0V3SkJWREVnTUI0R0ExVUVDZ3dYVEc5NGIyNWxJRVZzWldOMGNtOXUNCmFXTnpJRWR0WWtneEZ6QVZCZ05WQkFzTURtMTFjMmxqYzJWeWRtVnlYM1l5TVJVd0V3WURWUVFEREF3MU1EUkcNCk9UUkdNREV5UWpVd2dnSWlNQTBHQ1NxR1NJYjNEUUVCQVFVQUE0SUNEd0F3Z2dJS0FvSUNBUUNCWHl5S1dFcm4NCjY0SU5iMTg1ZnZtVTE3d1hvazVMYWNNZVZGRDdxQXoxcldKemIrODJ3elo1N1kwWW54MGJEK2ZXd2xsN2tqcTUNCnZPaXdzY2dWZ0hzZmVEQUZXY0UzVkZzVW1ENlc4bG41LzRQdkZFNDhSUE1heThSbzdhdHNLendPQ2RtNnk2MTMNCnRzS1k2eXBkQkwzaGdwRXhLRTBKWmg0My90M04zYXhvUEJVNHpyQ0lvYzVpWTlEZzhRaER6b0M1ak1qdzgwTjkNCkI2WEp5TmRRVU11VFRsdllBZ1dkbmQ5Q0hOTlp4NW45VDB3L1k0Qkw4U1VGcXVHUExXd1NRZW9URC8vTUpGejMNCmlnVXUzR2dGQW1Ld0NyY0NnUWN2d0dNR2ZjRHd1VjM0bGUrQXNxMitLbjBFU3VybmJyYXhxRVdOcDdFNGQ4RTgNCnR0ZGR4eWQ5Q3V5NzJzQ0JtOCtVQ2xocUJjNmNVWStmZGVaSDJCcEdQMDJSZFZscXhoSWsrc0Fwa2NtUzdGdFENCjhCU2VYbFlxRkYyZkVhc2xLd1VrRkdaWmV5Ukk0Q3VXSlA2VTU0L0NnRTlsaVNIVUxkZG5HSklJbGRkYWs5UDkNCnM4QW1JRGFyQzB2MWg3QWFINlZ4Vm9MOVJyQ1lYWWl3MElwZE1UMTJXNTFzdkNHa01oM01NWE1iQlJVSXNIb1UNCkNiYkwzQWNwWDd1UVpncTAwSGdZUElPZ2pMN21PMk9Id1k0dmJuTVkvSkRKcHFHaUU0dFVFZ2Uxb2NhcjhqMUYNCjdQTDFCcVZhOHFvZEIwai9tWW1ydGtMdEp2aUN0OVUxS01GT1E2dVpZSGN0RzlZcklBMkpuOU1ucEhlRlFySUMNCklZSjNiVEVzc3BJdTNlWFg2Vk5TdTFpNE9tQXdkZFNGbVFJREFRQUJvNElCTmpDQ0FUSXdDUVlEVlIwVEJBSXcNCkFEQVJCZ2xnaGtnQmh2aENBUUVFQkFNQ0JzQXdNd1lKWUlaSUFZYjRRZ0VOQkNZV0pFOXdaVzVUVTB3Z1IyVnUNClpYSmhkR1ZrSUZObGNuWmxjaUJEWlhKMGFXWnBZMkYwWlRBZEJnTlZIUTRFRmdRVVc5ZXMwY0M0QWpzdHRlcDgNCnFmaDhEc3BoSkJrd2dZNEdBMVVkSXdTQmhqQ0JnNEFVbWRvYjVLY1l6SElXVG1Qc2RpZzVkaVhHbk91aFo2UmwNCk1HTXhDekFKQmdOVkJBWVRBa0ZVTVJBd0RnWURWUVFJREFkQmRYTjBjbWxoTVNBd0hnWURWUVFLREJkTWIzaHYNCmJtVWdSV3hsWTNSeWIyNXBZM01nUjIxaVNERWdNQjRHQTFVRUF3d1hjbTl2ZEMxallTNXNiM2h2Ym1WamJHOTENClpDNWpiMjJDQWhBRU1BNEdBMVVkRHdFQi93UUVBd0lGb0RBZEJnTlZIU1VFRmpBVUJnZ3JCZ0VGQlFjREFRWUkNCkt3WUJCUVVIQXdJd0RRWUpLb1pJaHZjTkFRRUxCUUFEZ2dJQkFKc2luRGdzRUFoc1A2RWtrNGMzWnM3UnZEa2cNCklTY3pLV1R5ZUpYQ0t5bHJxVVNUbDkzc0VWOElTbk5aTU8yTlowenhadWVodWFOK3FDa2kzVS9SQkxhYmJHNUwNClVYSit5NUZOM01EbjhPVjVlMmJRU205MXl1QU9JdC8zOXdzK2VVRTkrTGcvWmZqVVdJKzRmd0VOS2g2RkMzaFINCm5OcmFDRkJVbDQrVEIyelJ4OHVpNnUwc3h2Slk5RGl0ajlUS0VjeVFLa3YxQ1hKSVZqM2dhOFVQb3pJcFZiR2oNCm9WTUpBMUtQU0FQckNZZEd4TDQ4S0JVWFk2aXV4d0RheGx3SGozSmM5V3ZxMjhyOEcveEthSlZRTVZXdkpTSHENCkpUZGVxMWhQR1BxNE1EZXcxUkoxckdWNFVBUmlJQVRsdmZxbFIyQlBYeWQrdzM3Q3lsT3REZTh5VmVqczUzQWwNCm40QVd6NnFmc3BJMWN1eHJpQnR4eUxkOWZWTyt3TlZkME43NnhPYW1NUlJVdU1zV3hOVXZ5dE14MEpvSFpIYWoNCndaWHFoUG9WUUFZWW5teGg2TStqSmgyc2cxTmxlV2ZuRWhxazVJd2JqaUV6eXZqMk5jOUdndHg5dzRudW56blgNCllMeDhrRS9DTlZhMTRNWlJUNWkzd2tiOXZUTkhJamRVbUpVUGtJTnlVa2VJNnRNK1VFMFk3UkRFQTJiYWhnWncNClEyUUZORmFyMENwWVJiZUxBanU1Zkgweld1SjZCKzI0SlZqRXMydVF0Ly9YTVF3eXFkTVFMZTg1WDZ5c21WS28NCkZ0TXpVTkQ1bS9iWk1ZSGkxODdFS05VNnpETzlVMTQyN3p1NW92MHZiTUtlV1ZQTHYzWndHd3hDbFkxMVZlWWINCnVZTFJmY3drTEd4RGhtWDANCi0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0NCg=="}'
    //return '{"command":"secure/hello","error":0,"public_key":"LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0KTUlHZk1BMEdDU3FHU0liM0RRRUJBUVVBQTRHTkFEQ0JpUUtCZ1FEYUtQL0FPcWFwa2N0Nzh2c2t4VFpnMzNYawpVaVFwbDYyVzNicnIzQlI2Mnk2aU10RGE1NFozaUszV2x6Z1FFbE9FUldKbU12RjlzWFJaY2IzTGU2eElROTYwCm1UblVwcmRGUnQyYStzeGMzZ2pvR1FwMGVHZEF1QjRjNC9GVVlEdWRiVy9Yak9KUVhQeHpIWGgzQjhFbjR0UFQKWDFxS3FVMm5KR3AyZXhiTjlRSURBUUFCCi0tLS0tRU5EIFBVQkxJQyBLRVktLS0tLQ=="}'
  }

  async _secureInit(url) {
    const [, , jwt] = url.split('/');
    //console.log(this._lc, this._rsaKey.decrypt(jwt).toString());
    return '{"command":"secure/init","error":0,"jwt":"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.ewogICJleHAiOiAxNjQwNjEwMTQ0LAogICJpYXQiOiAxNjQwNjEwMDg0LAogICJzZXNzaW9uX3Rva2VuIjogIjhXYWh3QWZVTHdFUWNlOVl1MHFJRTlMN1FNa1hGSGJpME05Y2g5dktjZ1lBclBQb2pYSHBTaU5jcTBmVDNscUwiLAogICJzdWIiOiAic2VjdXJlLXNlc3Npb24taW5pdC1zdWNjZXNzIgp9.Zd5M55YPirdugqlGr7u6iB-kM_oFqnvMnpxL8gj58vF2L4ocpSY6S8OB_4f8LeIB2AIYikN5U6R0UALJ3Oahxa0gq9qKDoNrjC7-Q8wAe1rEhDbvdWtaRzmgiHnivrz0cNsyeYGBX8c5Ix6pLI8URGjR1Ox2lbxBt_pVZ-MyEvhVNSJ0-DttclqIAgr_24tVmwe6lleT5eKyBoQVAcGJP-3LSdORKckHTCRw6aaf6sOQ7AtK37SXgnHB6J4g2wErvyw29mMAmDTbR8vZUCmTxgnmhbrks02AZITLaDeGAYTlSASWDSl84L9wkWOWk0pufZIGG0zcXgL8EoWD8cw_fIhbh-LXODEY5251u0DlVtaI_6J6o2j8jy_WvsSqKh-sqqy-ygScwPkLgFua7GNlppaHUGsFaEg0rVdLvVAiIV3mbOGnis1RuWcTWY9iuPVxFTODxkOZNRgZttBb_NFa8lQPJKwwhA33YC1hJ6DE3xEC2rvc4LGE400nLKnELNKpFNsom07JFSQQq8NV3Z1lzTksa8ANdXrV080J8x0c1Bt4dcUyx3lzFE8XG3DsLXCnL2YsJ9ik2jdSBZL8grnoQjqvJWaX3j47P0VM-jaMICVb6QcVP-nNB7k5n1qQGASsbkhcB1nffzE_wLooUe4iLxJQ2dkCM1n7ngXDF6HK0_A"}'
    //return '{"command":"secure/init","error":0,"jwt":"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE2NDA2MTAxNDQsImlhdCI6MTY0MDYxMDA4NCwic2Vzc2lvbl90b2tlbiI6IjhXYWh3QWZVTHdFUWNlOVl1MHFJRTlMN1FNa1hGSGJpME05Y2g5dktjZ1lBclBQb2pYSHBTaU5jcTBmVDNscU0iLCJzdWIiOiJzZWN1cmUtc2Vzc2lvbi1pbml0LXN1Y2Nlc3MifQ.Zd5M55YPirdugqlGr7u6iB-kM_oFqnvMnpxL8gj58vF2L4ocpSY6S8OB_4f8LeIB2AIYikN5U6R0UALJ3Oahxa0gq9qKDoNrjC7-Q8wAe1rEhDbvdWtaRzmgiHnivrz0cNsyeYGBX8c5Ix6pLI8URGjR1Ox2lbxBt_pVZ-MyEvhVNSJ0-DttclqIAgr_24tVmwe6lleT5eKyBoQVAcGJP-3LSdORKckHTCRw6aaf6sOQ7AtK37SXgnHB6J4g2wErvyw29mMAmDTbR8vZUCmTxgnmhbrks02AZITLaDeGAYTlSASWDSl84L9wkWOWk0pufZIGG0zcXgL8EoWD8cw_fIhbh-LXODEY5251u0DlVtaI_6J6o2j8jy_WvsSqKh-sqqy-ygScwPkLgFua7GNlppaHUGsFaEg0rVdLvVAiIV3mbOGnis1RuWcTWY9iuPVxFTODxkOZNRgZttBb_NFa8lQPJKwwhA33YC1hJ6DE3xEC2rvc4LGE400nLKnELNKpFNsom07JFSQQq8NV3Z1lzTksa8ANdXrV080J8x0c1Bt4dcUyx3lzFE8XG3DsLXCnL2YsJ9ik2jdSBZL8grnoQjqvJWaX3j47P0VM-jaMICVb6QcVP-nNB7k5n1qQGASsbkhcB1nffzE_wLooUe4iLxJQ2dkCM1n7ngXDF6HK0_B"}'
    //return '{"command":"secure/init","error":0,"jwt":"' + jwt + '"}'
    //return '{"ready_result": {"session":547541322864}, "command": "audio/cfg/ready"}'
  }

  async _securePair(url) {
    return '{"command":"secure/pair","error":0,"response":{"command":"pair-request-response","session_token":"8WahwAfULwEQce9Yu0qIE9L7QMkXFHbi0M9ch9vKcgYArPPojXHpSiNcq0fT3lqL"}}';
  }

  async _secureForget(url) {
    fs.unlinkSync(".music.json");
    process.exit(0);
  }

  async _secureInfoPairing(url) {
    return '{"command":"secure/info/pairing","error":-81,"master":"' + this.msMAC + '","peers":[]}'
  }

  async _secureAuthenticate(url) {
    return this._emptyCommand(url, "authentication successful");
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
    console.warn(this._lc, '####################################################################');
    console.warn(this._lc, '######################## UNKNOWN COMMAND ###########################');
    console.warn(this._lc, '####################################################################');
    console.warn(this._lc, url);
    console.warn(this._lc, '####################################################################');
    console.warn(this._lc, '####################################################################');
    console.warn(this._lc, '####################################################################');

    return this._emptyCommand(url, null);
  }

  _getSyncState() {
    const syncGroups = this._master ? this._master.getSyncGroups() : [];

    var groups = []
    var masterZoneVolume = -1
    var mastervolume = -1
    for (var i in syncGroups) {
        var players = []
        for (var j in syncGroups[i]) {
            var zoneId = syncGroups[i][j];
            var vol = this._zones[zoneId].getVolume();
            if (j == 0)
                masterZoneVolume = vol;
            if (mastervolume == -1) {
                if (this._zones[zoneId].getPower() == "on")
                    mastervolume = vol;
            }
            players.push({ id: zoneId.toString(), playerid: +zoneId })
        }
        if (mastervolume == -1)
            mastervolume = masterZoneVolume;
        groups.push({ group: i.toString(), players, mastervolume, type: "dynamic" });
    }

    return groups;
  }

  _getAudioState(zone) {
    const repeatModes = {0: 0, 2: 1, 1: 3};
    const playerId = getKeyByValue(this._zones, zone);

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
      audiotype: track.duration == 0 ? 1 : 2,
      coverurl: this._imageUrl(track.image || ''),
      duration: mode === 'buffer' ? 0 : Math.ceil(track.duration / 1000),
      mode: mode === 'buffer' ? 'play' : mode,
      players: [{playerid: playerId}],
      plrepeat: repeatModes[zone.getRepeat()],
      plshuffle: zone.getShuffle(),
      // This seems to be ignored by the Miniserver. Qa is only 1 when currently playing
      // The new AudioServer UI doesn't like any other value here.
      power: "on", //zone.getPower(),
      station: track.station,
      time: zone.getTime() / 1000,
      qindex: track.qindex ? track.qindex : 0,
      title: track.title,
      volume: zone.getVolume(),
      default_volume: zone.getDefaultVolume(),
      max_volume: zone.getMaxVolume(),
      icontype: zone.getIconType(),
      // Needs to be one of the unique_ids in the queue
      qid: track.qindex ? track.qindex.toString() : "0",
      parent: null,
      type: zone.getIconType() != -1 ? 6 : 1,
    };
  }

  _getSyncedGroupInfo(zoneId) {
     const syncGroups = this._master.getSyncGroups();

     var audioSyncEvent = []
     for (var i in syncGroups) {
         if (syncGroups[i].includes(+zoneId)) {
             return {
                groupIndex: i,
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
      var plus = ""
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
         plus = item.plus ? item.plus : ""
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
        // Used as identifier for queue management (checked against qid in current track)
        unique_id: (item.qindex != undefined) ? item.qindex.toString() : undefined,
        audiotype: 0, // FILE // needed for clickable queue items. Might need adaption for other items ?
        contentType,
        mediaType,
        plus
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
