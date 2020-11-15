'use strict';

const LMSClient = require('./lms-client');
const MusicList = require('./music-list');

module.exports = class MusicMaster {
  constructor(musicServer) {
    this._musicServer = musicServer;

    this._inputs = new MusicList(musicServer, '/inputs');
    this._favorites = new MusicList(musicServer, '/favorites');
    this._playlists = new MusicList(musicServer, '/playlists');
    this._library = new MusicList(musicServer, '/library');
    this._radios = new MusicList(musicServer, '/radios');
    // This is not zone specific but we still need to use a zone for the call to work correctly
    this._services = new MusicList(musicServer, '/services', musicServer._zones[0]);
    this._serviceFolder = new MusicList(musicServer, '/servicefolder', musicServer._zones[0]);

    this._client = new LMSClient(this._musicServer._zones[0]._zone_mac);

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

  async getSearchableTypes() {
    // Spotify is a bit tricky as the search results are mixed
    // folders and tracks
    // Here we just retrieve the folders to build a list of categories supported
    let response = await this._client.command('spotty items 0 100 item_id:0.0');
    let data = this._client.parseAdvancedQueryResponse(response, 'id');

    // Use the base search folder to get results for tracks as well
    this.spotify_categories = { '0.0': "Tracks" }
    for (var key in data.items) {
        if (!data.items[key].id)
            continue;
        this.spotify_categories[data.items[key].id] = data.items[key].name
    }
    console.log(this.spotify_categories)

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
    if (type == 'local') {
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

        let config = itemMap.find( element => { return category == element.cmd });
        let response = await this._client.command(category + ' ' + start + ' ' + length + " search:" + search + " tags:uKjJt");
        let data = this._client.parseAdvancedQueryResponse(response, config.split_key);

        let items = data.items;
        data.name = config.name;
        data.items = []
        for (var key in items) {
            data.items.push({
                                id: category == "tracks" ? "url:" + items[key].url : config.id_key + ":" + items[key][config.split_key],
                                title: decodeURI(items[key][config.name_key]),
                                image: await this._client.extractArtwork(items[key].url, items[key]),
                                type: category == "tracks" || items[key].type == "track"  ? 2 : 1
                           })
        }
        return data;
    } else if (type == 'tunein') {
        let response = await this._client.command('search items ' + start + ' ' + length + " search:" + search);
        let data = this._client.parseAdvancedQueryResponse(response, 'id');

        let items = data.items;
        data.name = "Stations";
        data.items = []
        for (var key in items) {
            if (!items[key].id)
                continue;
            data.items.push({
                                id: "service/search:" + items[key].id,
                                title: decodeURI(items[key].name),
                                image: await this._client.extractArtwork(items[key].url, items[key]),
                                type: items[key].type != "link"  ? 2 : 1
                           })
        }
        return data;
    } else if (type == 'spotify') {
        const folderLength = Object.keys(this.spotify_categories).length - 1;

        // In this id we get tracks and folders mixed.
        // The first X tracks are folder so we need to fetch more just to get tracks
        if (category == "0.0" && start == 0)
            length = Number(length) + folderLength;

        let response = await this._client.command('spotty items ' + start + ' ' + length + " search:" + search + " item_id:" + category);
        let data = this._client.parseAdvancedQueryResponse(response, 'id');

        // In this id we get tracks and folders mixed.
        // Use the already retrieved folders to calculate the correct count
        if (category == "0.0")
            data.count = data.count - folderLength

        data.name = this.spotify_categories[category];

        let items = data.items;
        data.items = []
        for (var key in items) {
            if (!items[key].id)
                continue;

            if (category == "0.0" && key <= folderLength)
                continue;

            data.items.push({
                                id: "service/spotty:" + items[key].id,
                                title: decodeURI(items[key].name),
                                image: await this._client.extractArtwork(items[key].url, items[key]),
                                type: items[key].type == "playlist" ? 11 //playlist
                                                                    : items[key].isaudio == "1" ? 2 : 1 //folder
                           })
        }
        return data;
    }
  }

  async playUploadedFile(path, zones) {
    this._client.execute_script("playUploadedFile", { zones, path })
  }

  _call() {
    const callback = () => this._musicServer.call(...arguments);

    return (this._last = this._last.then(callback, callback));
  }
}
