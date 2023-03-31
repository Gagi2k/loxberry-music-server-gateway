'use strict';

const LMSClient = require('./lms-client');
const MusicList = require('./music-list');
const fs = require('fs');
const config = JSON.parse(fs.readFileSync("config.json"));

const Log = require("../log");
const console = new Log;

module.exports = class MusicMaster {
  constructor(musicServer) {
    this._musicServer = musicServer;
    this._lc = musicServer.loggingCategory().extend("MASTER");

    this._inputs = new MusicList(musicServer, '/inputs', this);
    this._favorites = new MusicList(musicServer, '/favorites', this, musicServer._masterZone);
    this._playlists = new MusicList(musicServer, '/playlists', this);
    this._library = new MusicList(musicServer, '/library', this);
    this._radios = new MusicList(musicServer, '/radios', this);
    // This is not zone specific but we still need to use a zone for the call to work correctly
    this._services = new MusicList(musicServer, '/services', this, musicServer._masterZone);
    this._serviceFolder = new MusicList(musicServer, '/servicefolder', this, musicServer._masterZone);

    this._client = new LMSClient(this._musicServer._masterZone._zone_mac, this);

    this._globalClient = new LMSClient(undefined, this, (data) => {
        console.log(this._lc, "LMS NOTIFICATION:", data)
        if (data == "rescan done") {
            console.log(this._lc, "RESCAN DONE");
            musicServer._pushScanStatusChangedEvent(0);
        } else if (data.includes(" sync ") ||
                   data.includes(" power ")) {
            //The sync master changes dynamically when the current master it turned off
            this.fetchSyncGroups();
        }
    });

    this.fetchSyncGroups();
  }

  loggingCategory() {
    return this._lc;
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
    return this._syncGroups;
  }

  async powerOff() {
    this._client.execute_script("powerOff")
    return;
  }

  async reboot() {
    this._client.execute_script("reboot")
    return;
  }

  async diagnosis() {
    var str = await this._client.execute_script("diagnosis");
    if (str)
        return JSON.parse(str);
    return {};
  }

  async scanStatus() {
    return await this._globalClient.command('rescan ?');
  }

  async rescanLibrary() {
    await this._globalClient.command('rescan');

    this._musicServer._pushScanStatusChangedEvent(1);
  }

  // error: returnValue
  // NONE: 0,
  // NON_EXISTENT: 1,
  // UNREACHABLE: 2,
  // INVALIDE_CREDS: 12
  async addNetworkShare(config) {
    config.configBase64 = Buffer.from(JSON.stringify(config), 'utf-8').toString("base64");
    this._client.execute_script("addNetworkShare", config)
    return 0;
  }

  async fetchSyncGroups() {
    if (!this._syncGroupsFetching) {
        this._syncGroupsFetching = true;

        setTimeout(async () => {
           let response = await this._globalClient.command('syncgroups ?');
           let data = this._client.parseAdvancedQueryResponse(response, 'sync_members');

           console.log(this._lc, data);

           let groups = []
           for (var key in data.items) {
               let macs = unescape(data.items[key].sync_members).split(',');
               let zones = []
               for (var i in macs) {
                   var zone = Object.keys(this._musicServer._zones).find( key => this._musicServer._zones[key]._zone_mac === macs[i]);
                   if (zone)
                       zones.push(+zone)
               }
               groups.push(zones);
           }

           this._syncGroups = groups;
           this._musicServer._pushAudioSyncEvents();
           this._syncGroupsFetching = false;
        }, 100);
    }
  }

  async getSearchableTypes() {
    // First try to find the Id for the search menu
    // Depending on the plugin mode, the id is different.
    let response = await this._client.command('spotty items 0 100');
    let data = this._client.parseAdvancedQueryResponse(response, 'id');
    this.search_menu_id;
    for (var key in data.items) {
        // We search for the search icon to identify the menu
        if (!data.items[key].image.includes("search"))
            continue;
        this.search_menu_id = data.items[key].id + ".0";
    }

    // Spotify is a bit tricky as the search results are mixed
    // folders and tracks
    // Here we just retrieve the folders to build a list of categories supported
    response = await this._client.command('spotty items 0 100 item_id:' + this.search_menu_id);
    data = this._client.parseAdvancedQueryResponse(response, 'id');

    // Use the base search folder to get results for tracks as well
    this.spotify_categories = {}
    this.spotify_categories[this.search_menu_id] = "Tracks";
    for (var key in data.items) {
        if (!data.items[key].id)
            continue;
        this.spotify_categories[data.items[key].id] = data.items[key].name
    }

    // Every key corresponds to one search == one list of result
    // The sample does three searches
    // Every key contains a list of categories which should be searched in
    // All of this is passed to the search function
    return {
        spotify: Object.keys(this.spotify_categories),
        local: ['artists', 'albums', 'playlists', 'genres', 'tracks'],
        tunein: ['all']
    }
  }

  async search(type, category, search, start, length) {
    console.log(this._lc, "SEARCH:", type, category, search, start, length)
    if (type == 'local' || type == "library") {
        // This is a copy from the music-list
        // TODO get rid of the copy and share it somehow
        const itemMap = [{ name: 'Artists', cmd: 'artists', next_cmd: 'albums', filter_key: "artist_id", name_key: 'artist', split_key: 'id', id_key: 'artist' },
                         { name: 'Albums', cmd: 'albums', next_cmd: 'tracks', filter_key: "album_id", name_key: 'title', split_key: 'id', id_key: 'album' },
                         { name: 'Tracks', cmd: 'tracks', next_cmd: '', filter_key: "track_id", name_key: 'title', split_key: 'id', id_key: 'url' },
                         { name: 'Years', cmd: 'years', next_cmd: 'artists', filter_key: "year", name_key: 'year', split_key: 'year', id_key: 'year' },
                         { name: 'Genres', cmd: 'genres', next_cmd: 'artists', filter_key: "genre_id", name_key: 'genre', split_key: 'id', id_key: 'genre' },
                         { name: 'Folders', cmd: 'musicfolder', next_cmd: 'musicfolder', filter_key: "folder_id", name_key: 'title', split_key: 'id', id_key: 'folder' },
                         { name: 'Playlists', cmd: 'playlists', next_cmd: '', filter_key: "playlist_id", name_key: 'playlist', split_key: 'id', id_key: 'playlist' }
                        ];

        let config = itemMap.find( element => { return element.cmd.startsWith(category) });
        let response = await this._client.command(config.cmd + ' ' + start + ' ' + length + " search:" + search + " tags:uKjJt");
        let data = this._client.parseAdvancedQueryResponse(response, config.split_key);

        let items = data.items;
        data.name = config.name;
        data.items = []
        for (var key in items) {
            let isTrack = config.cmd == "tracks" || items[key].type == "track";
            let id = isTrack ? "url:" + items[key].url : config.id_key + ":" + items[key][config.split_key];
            data.items.push({
                                id,
                                identifier: config.cmd,
                                lastSelectedItem: { id },
                                title: decodeURIComponent(items[key][config.name_key]),
                                image: await this._client.extractArtwork(items[key].url, items[key]),
                                type: isTrack ? 2 : 1
                           })
        }
        return data;
    } else if (type == 'tunein' || type == 'radio') {
        let response = await this._client.command('search items ' + start + ' ' + length + " search:" + search);
        let data = this._client.parseAdvancedQueryResponse(response, 'id');

        let items = data.items;
        data.name = "Stations";
        data.items = []
        for (var key in items) {
            if (!items[key].id)
                continue;
            let id = "service/search:" + items[key].id;
            data.items.push({
                                id,
                                identifier: "search",
                                lastSelectedItem: { id },
                                title: decodeURIComponent(items[key].name),
                                image: await this._client.extractArtwork(items[key].url, items[key]),
                                type: items[key].type != "link"  ? 2 : 1
                           })
        }
        return data;
    } else if (type == 'spotify') {
        const folderLength = Object.keys(this.spotify_categories).length - 1;

        const categoryMap = {
            "track" : "1.0",
            "artist" : "1.0.0",
            "album" : "1.0.1",
            "playlist" : "1.0.2"
        }
        if (category in categoryMap)
            category = categoryMap[category];

        // In this id we get tracks and folders mixed.
        // The first X tracks are folder so we need to fetch more just to get tracks
        if (category == this.search_menu_id && start == 0)
            length = Number(length) + folderLength;

        let response = await this._client.command('spotty items ' + start + ' ' + length + " search:" + search + " item_id:" + category);
        let data = this._client.parseAdvancedQueryResponse(response, 'id');

        // In this id we get tracks and folders mixed.
        // Use the already retrieved folders to calculate the correct count
        if (category == this.search_menu_id)
            data.count = data.count - folderLength

        data.name = this.spotify_categories[category];

        let items = data.items;
        data.items = []
        for (var key in items) {
            if (!items[key].id)
                continue;

            if (category == this.search_menu_id && key <= folderLength)
                continue;

            let id = "service/spotty:" + items[key].id;
            data.items.push({
                                id,
                                identifier: "spotty",
                                lastSelectedItem: { id },
                                title: decodeURIComponent(items[key].name),
                                image: await this._client.extractArtwork(items[key].url, items[key]),
                                type: items[key].type == "playlist" ? 11 //playlist
                                                                    : items[key].isaudio == "1" ? 2 : 1 //folder
                           })
        }
        return data;
    }
  }

  async playGroupedTTS(zones, language, text) {
    var macs = zones.map(x => { var [zone, vol] = x.split("~"); return this._musicServer._zones[zone]._zone_mac + "~" + vol}).join(",");

    this._client.execute_script("playGroupedTTS", { language, text, zones, macs })
  }

  async playGroupedAlarm(type, zones) {
    var macs = zones.map(x => { var [zone, vol] = x.split("~"); return this._musicServer._zones[zone]._zone_mac + "~" + vol}).join(",");

    this._client.execute_script("playGroupedAlarmSound", { type, zones, macs })
  }

  async stopGroupedAlarm(type, zones) {
    var macs = zones.split(',').map(x => this._musicServer._zones[x]._zone_mac).join(",");

    this._client.execute_script("stopGroupedAlarmSound", { type, zones, macs })
  }

  async playUploadedFile(path, zones) {
    console.log(this._lc, zones)
    var macs = zones.split(',').map(x => this._musicServer._zones[x]._zone_mac).join(",");

    this._client.execute_script("playUploadedFile", { zones, path, macs })
  }

  _call() {
    const callback = () => this._musicServer.call(...arguments);

    return (this._last = this._last.then(callback, callback));
  }
}
