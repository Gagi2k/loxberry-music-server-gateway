'use strict';

const LMSClient = require('./lms-client');
const fs = require('fs');
const Mutex = require('async-mutex');
const os = require('os');
const config = JSON.parse(fs.readFileSync("config.json"));

const Log = require("../log");
const console = new Log;

module.exports = class List {
  constructor(musicServer, url, parent, zone) {
    this._musicServer = musicServer;
    this._url = url;
    this._lc = parent.loggingCategory().extend(url.split('/').pop().toUpperCase());
    this._zone = zone;
    this._zone_mac = zone ? zone._zone_mac : undefined
    this._mutex = new Mutex.Mutex();

    if (url.endsWith("/favorites")) {
        this._helper = new LMSClient(this._musicServer._zones[0]._zone_mac, this);
        this._client = new LMSClient(undefined, this, (data) => {
             if (data.startsWith("favorites")) {
                 this.reset()
                 musicServer._pushFavoritesChangedEvent();
             }
         });
        this.get_call = async (rootItem, start, length) => {
            let response = await this._client.command('favorites items ' + start + ' ' + length + ' want_url:1');
            let data = this._client.parseAdvancedQueryResponse(response, 'id', ['title']);
            let items = data.items;
            data.items = []
            for (var key in items) {
                // Filter all favorites which are folders
                // This won't work if this function is called multiple times as the data.count
                // would be wrong. Instead we should fetch all favs in one call (currently 50)
                if (items[key].isaudio == "1") {
                    data.items.push({
                                       // If we don't have a url, we fallback to use the id instead
                                       // For example in folders
                                       id: items[key].url ? "url:" + items[key].url : "fav:" + items[key].id,
                                       favId: items[key].id.split('.').pop(),
                                       name: decodeURIComponent(items[key]["name"]),
                                       image: await this._client.extractArtwork(items[key].url, items[key])
                                   })
                } else {
                    data.count = data.count - 1
                }
            }
            return data
        }
        this.insert_call = async (position, ...items) => {
            for (var i in items) {
                let url = await this._helper.resolveAudioUrl(items[i].id)
                if (!url)
                    continue;
                var cmd = 'favorites add item_id:' + position + ' title:' + encodeURI(items[i].title) + ' url:' + url;
                if (items[i].image)
                    cmd += " icon:" + this._client.toStorableUrl(items[i].image)
                await this._client.command(cmd);
            }
        }
        this.delete_call = async (position, length) => {
            for (var i=0; i<length; i++) {
                var item = +position + i
                await this._client.command('favorites delete item_id:' + item);
            }
        }
    } else if (url.endsWith("zone_favorites")) {
        this._client = new LMSClient(this._zone_mac, this);
        let fileName = 'zone_favorite_' + this._zone._id + '.json'
        let fav_items = [{id:-1, title: "Dummy"}]
        if (fs.existsSync(fileName)) {
            let rawdata = fs.readFileSync(fileName);
            fav_items = JSON.parse(rawdata);
        }
        fav_items.fill({}, fav_items.length, 8);

        this.get_call = async (rootItem, start, length) => {
            for (var key in fav_items) {
                if (fav_items[key].image)
                    fav_items[key].image = this._client.resolveUrl(fav_items[key].image)
            }
            return { count: fav_items.length, items: fav_items };
        }
        this.insert_call = async (position, ...items) => {
            for (var key in items) {
                if (!items[key].id)
                    continue;

                let url = await this._client.resolveAudioUrl(items[key].id)
                if (!url)
                    return;
                items[key].id = "url:" + url;
            }

            fav_items.splice(position, 1, ...items);

            for (var key in fav_items) {
                if (fav_items[key].image)
                    fav_items[key].image = this._client.toStorableUrl(fav_items[key].image);
            }
            let data = JSON.stringify(fav_items);
            fs.writeFileSync(fileName, data);
            this.reset()
            this._zone._pushRoomFavChangedEvent();
        }
        this.delete_call = async (position, length) => {
            for (var i = 0; i<length; i++)
                fav_items.splice(position + i, 1, {});
            let data = JSON.stringify(fav_items);
            fs.writeFileSync(fileName, data);
            this.reset()
            this._zone._pushRoomFavChangedEvent();
        }
    } else if (url.endsWith("playlists")) {
        this._helper = new LMSClient(this._musicServer._zones[0]._zone_mac, this);
        this._client = new LMSClient(this._zone_mac, this);
        this.get_call = async (rootItem, start, length) => {
            if (!rootItem) {
                let response = await this._client.command('playlists ' + start + ' ' + length + " tags:u:playlist");
                let data = this._client.parseAdvancedQueryResponse(response, 'id');
                let items = data.items;
                data.items = []
                for (var key in items) {
                    // Filter all temporary playlists
                    // This won't work if this function is called multiple times as the data.count
                    // would be wrong. Instead we should fetch all favs in one call (currently 50)
                    if (!items[key].playlist.startsWith("temp_")) {
                        data.items.push({
                                           id: "playlist:" + items[key].id,
                                           title: decodeURIComponent(items[key]["playlist"]),
                                           // playlists don't have a artwork
                                           image: undefined,
                                       })
                    } else {
                        data.count = data.count - 1
                    }
                }
                return data;
            } else {
                let parsed_id = this._client.parseId(rootItem);
                let response = await this._client.command('playlists tracks ' + start + ' ' + length + " playlist_id:" + parsed_id.id + " tags:uKJN");
                let data = this._client.parseAdvancedQueryResponse(response, 'playlist%20index');
                let items = data.items;
                data.items = []
                for (var key in items) {
                    data.items.push({
                                       id: "url:" + items[key].url,
                                       title: decodeURIComponent(items[key].title),
                                       image: await this._client.extractArtwork(items[key].url, items[key]),
                                       type: 2 //File
                                   })
                }
                return data;
            }
        }
        this.insert_call = async (position, ...items) => {
            // position is used for the playlist id
            if (position) {
                let playlist_id = this._client.parseId(position).id
                for (var i in items) {
                    let id = items[i].id;
                    let parsed_id = this._client.parseId(id);
                    let list;
                    var urlList = []
                    if (parsed_id.type == "url") {
                        urlList.push(parsed_id.id);
                    } else if (parsed_id.type.startsWith('service/')) {
                        list = parent.getServiceFolderList()
                        id = parsed_id.type.split('/').pop() + '%%%' + '%%%' + id
                    } else {
                        list = parent.getLibraryList()
                    }

                    // Recursive function to iterate over all entries and it to the list of urls
                    // Iterate deeper if the item doesn't have a url
                    var extractUrl = async (id) => {
                        var urlList = []
                        // Limit it to 200 items to keep the implementation simple
                        var response = await list.get(id, 0, 200);
                        for (var j=0; j<response.total; j++) {
                            if (!response.items[j])
                                continue;
                            if (response.items[j].type == 2) {
                                var id = response.items[j].id;
                                var item = response.items[j];
                                if (id.startsWith("url:"))
                                    urlList.push(this._helper.parseId(id).id);
                                else
                                    urlList.push(await this._helper.resolveAudioUrl(id));
                            } else {
                                urlList = urlList.concat(await extractUrl(response.items[j].id));
                            }
                        }

                        return urlList
                    }

                    if (urlList.length == 0)
                        urlList = await extractUrl(id)

                    for (var k in urlList)
                        await this._client.command('playlists edit cmd:add playlist_id:' + playlist_id + ' url:' + urlList[k]);
                }
            } else {
                for (var i in items) {
                    //Create a new playlist
                    let response = await this._client.command('playlists new name:' + encodeURI(items[i].title));
                    const [ , id] = response.split("%3A")
                    this.reset();
                    musicServer._pushPlaylistsChangedEvent("playlist:" + id, "create", items[i].title);
                }
            }
        }
        this.delete_call = async (position, length) => {
            // Instead of passing the position, we pass the playlist_id directly
            let parsed_id = this._client.parseId(position);
            await this._client.command('playlists delete playlist_id:' + parsed_id.id);
            this.reset();
            musicServer._pushPlaylistsChangedEvent(position, "delete");
        }
    } else if (url.endsWith("queue")) {
        this._client = new LMSClient(this._zone_mac, this, (data) => {
             if (data.startsWith("playlist load") || data.startsWith("playlist play") ||
                 data.startsWith("playlist delete") || data.startsWith("playlist move") ||
                 data.startsWith("playlist addtracks") || data.startsWith("playlist shuffle") ||
                 data.startsWith("playlist clear") ||
                 data.startsWith("newmetadata")) {
                console.log(this._lc, "TRIGGER QUEUE REFRESH ZONE" + this._zone._id)
                this.reset();
                musicServer.pushQueueEvent(this._zone)
             }
         });
        this.get_call = async (rootItem, start, length) => {
            let response = await this._client.command('status ' + start + ' ' + length + " tags:aluKJN");
            let data = this._client.parseAdvancedQueryResponse(response, 'id', [''], "playlist_tracks");
            let items = data.items.slice(1);
            data.items = []
            for (var key in items) {
                var image = undefined;
                var condition = true;
                // Only load the image of the current Item, all others should stay empty to
                // improve the performance of the app.
                if (config.useSlowQueueWorkaround) {
                    condition = (Number(start + key) == parent.getTrack().qindex)
                }
                if (condition)
                    image = await this._client.extractArtwork(items[key].url, items[key]);

                data.items.push({
                                   id: "url:" + items[key].url,
                                   title: items[key].title ? decodeURIComponent(items[key].title) : undefined,
                                   station: items[key].remote_title ? decodeURIComponent(items[key].remote_title) : undefined,
                                   artist: items[key].artist ? decodeURIComponent(items[key].artist) : undefined,
                                   album: items[key].album ? decodeURIComponent(items[key].album) : undefined,
                                   image: image
                               })
            }
            return data
        }
        this.insert_call = async (position, ...items) => {
            for (var i in items) {
                let cmd = "insert"
                if (position == this._itemMap.get(undefined).total)
                    cmd = "add"

                let parsed_id = this._client.parseId(items[i].id);
                if (parsed_id.type == "url")
                    await this._client.command('playlist ' + cmd + ' ' + parsed_id.id);
                else if (parsed_id.type == "playlist" ||
                         parsed_id.type == "artist" ||
                         parsed_id.type == "album" ||
                         parsed_id.type == "year" ||
                         parsed_id.type == "genre" ||
                         parsed_id.type == "folder") {
                     var str = parsed_id.type + "_id:" + parsed_id.id;
                     await this._client.command('playlistcontrol cmd:' + cmd + " " + str);
                } else if (parsed_id.type == "fav"){
                    await this._client.command('favorites playlist ' + cmd + ' item_id:' + parsed_id.id);
                } else if (parsed_id.type.startsWith("service")){
                    const [, cat] = parsed_id.type.split("/");
                    await this._client.command(cat + ' playlist ' + cmd + ' item_id:' + parsed_id.id);
                }
            }
        }
        this.move_call = async (position, destination) => {
            await this._client.command('playlist move ' + position + " " + destination);
        }
        this.delete_call = async (position, length) => {
            for (var i=0; i<length; i++) {
                // TODO Test whether we need to really increase the position
                // TODO Check whether it is the position or the id which gets passed here
                var item = +position + i
                await this._client.command('playlist delete ' + item);
            }
        }
        this.clear_call = async () => {
            await this._client.command('playlist clear');
        }
    } else if (url.endsWith("library")) {
        this._client = new LMSClient(this._zone_mac, this);
        this.get_call = async (rootItem, start, length) => {
            const itemMap = [{ name: 'Artists', cmd: 'artists', next_cmd: 'albums', filter_key: "artist_id", name_key: 'artist', split_key: 'id', id_key: 'artist' },
                             { name: 'Albums', cmd: 'albums', next_cmd: 'tracks', filter_key: "album_id", name_key: 'title', split_key: 'id', id_key: 'album' },
                             { name: 'Tracks', cmd: 'tracks', next_cmd: '', filter_key: "track_id", name_key: 'title', split_key: 'id', id_key: 'url' },
                             { name: 'Years', cmd: 'years', next_cmd: 'artists', filter_key: "year", name_key: 'year', split_key: 'year', id_key: 'year' },
                             { name: 'Genres', cmd: 'genres', next_cmd: 'artists', filter_key: "genre_id", name_key: 'genre', split_key: 'id', id_key: 'genre' },
                             { name: 'Folders', cmd: 'musicfolder', next_cmd: 'musicfolder', filter_key: "folder_id", name_key: 'title', split_key: 'id', id_key: 'folder' }
                            ];
            if (!rootItem) {
                var data = [];
                for (var key in itemMap) {
                    data.push({ id: itemMap[key].cmd + ':0', title: itemMap[key].name, type:1 });
                }

                return { count: data.length, items: data }
            } else {
                let parsed_id = this._client.parseId(rootItem);
                let cmd = parsed_id.type;
                let filter = "";
                if (parsed_id.id != 0) {
                    let cur_config = itemMap.find(element => parsed_id.type == element.id_key);
                    cmd = cur_config.next_cmd;
                    filter = " " + cur_config.filter_key + ':' +  parsed_id.id;
                }
                let config = itemMap.find(element => cmd == element.cmd);
                let name_key = config.name_key;
                let split_key = config.split_key;

                let response = await this._client.command(cmd + ' ' + start + ' ' + length + filter + " tags:uKjJtc");
                let data = this._client.parseAdvancedQueryResponse(response, split_key);
                let items = data.items;
                data.items = []
                for (var key in items) {
                    let isTrack = cmd == "tracks" || items[key].type == "track";
                    data.items.push({
                                       id: isTrack ? "url:" + items[key].url : config.id_key + ":" + items[key][config.split_key],
                                       title: decodeURIComponent(items[key][name_key]),
                                       image: await this._client.extractArtwork(items[key].url, items[key]),
                                       type: isTrack  ? 2 : 1
                                   })
                }
                return data
            }
        }
    } else if (url.endsWith("radios")) {
        this._client = new LMSClient(this._zone_mac, this);
        this.get_call = async (rootItem, start, length) => {
            let response = await this._client.command('radios ' + start + ' ' + length);
            let data = this._client.parseAdvancedQueryResponse2(response, ["name", "icon", "type", "cmd", "weight"]);
            let items = data.items;
            data.items = []
            for (var key in items) {
                // Filter the search Folder
                if (config.filteredRadioEntries.includes(items[key].cmd)) {
                    data.count--;
                    continue;
                }

                data.items.push({
                                   // Always 0, as this is indicates no item_id for the servicefolder command
                                   id: 0,
                                   cmd: items[key].cmd,
                                   name: decodeURIComponent(items[key].name),
                                   icon: await this._client.extractArtwork(items[key].url, items[key])
                               })
            }
            return data
        }
    } else if (url.endsWith("services")) {
        this._client = new LMSClient(this._zone_mac, this);
        this.get_call = async (rootItem, start, length) => {
            let response = await this._client.command('spotty items 0 1');
            let data = this._client.parseAdvancedQueryResponse(response, 'id');
            if (data.count == 0)
                return { count: 0, items: [] };

            // In case the switcher menu is enabled, provide all users in the app as well
            let switcherMenu = await this._client.command('pref plugin.spotty:accountSwitcherMenu ?');
            if (switcherMenu == "1") {
                return this._client.spotifyAccountSwitcher();
            }

            return { count: 1, items: [{ name: "Spotify", cmd: "spotify", user: "Standard User", config: [{id: 0}]}] };
        }
    } else if (url.endsWith("servicefolder")) {
        this._client = new LMSClient(this._zone_mac, this);
        this.get_call = async (rootItem, start, length) => {

            var [cmd, user, id] = rootItem.split('%%%');
            if (cmd == "spotify")
                cmd = "spotty";

            if (id) {
                let parsed_id = this._client.parseId(id);
                // The app forwards from a radio search using the "local" cmd
                // This is a hack to make it work.
                if (parsed_id.type == "service/search")
                    cmd = "search";
            }/* else { // start menu
                // Check whether we need to switch the account
                this.accountSwitcher(user);
            }*/

            // Find a zone with that user and use it here
            // Create new client with that mac to use it now.
            if (cmd == "spotty" && user && user != "Standard User") {
                var zones = musicServer._zones;
                for (key in zones) {
                    console.log(this._lc, "CURRENT", zones[key].getCurrentSpotifyAccount())
                    console.log(this._lc, "WANTED", user);
                    if (zones[key].getCurrentSpotifyAccount() == user) {
                        this._client = zones[key]._client;
                        break;
                    }
                }
            }

            var itemId = id ? "item_id:" + this._client.parseId(id).id : ""

            let response = await this._client.command(cmd + ' items ' + start + ' ' + length + ' want_url:1 ' + itemId);
            let data = this._client.parseAdvancedQueryResponse(response, 'id');
            let isAudio = false

            if (!data.count)
                return data;

            let jsonResponse = await this._client.jsonRPCCommand(cmd + ' items ' + start + ' ' + length + ' want_url:1 menu:1 ' + itemId);

            // Special handling for Transfer Playback
            // We need to play those items to transfer it to the correct zone
            var transfer_playback_titles = [
                "Transfer%20Playback",
                "Wiedergabe%20%C3%BCbernehmen"
            ]
            if (transfer_playback_titles.includes(data.items[0].title))
                isAudio = true

            var switcher_titles = [
                "Account",
                "Konto"
            ]

            let items = data.items;
            if (!items[0].id)
                items = items.splice(1);
            data.items = []

            for (var key in items) {
                if (!items[key].id)
                    continue;

                // Don't show the search menu or the switcher menu
                if ((items[key].image && items[key].image.includes("search")) ||
                    switcher_titles.includes(items[key].name)) {
                    data.count--;
                    continue;
                }


                let id = "service/" + cmd + ":" + items[key].id
                if (items[key].type != "playlist" && items[key].isaudio == "1" &&
                    jsonResponse.item_loop[key] && jsonResponse.item_loop[key].presetParams)
                    id = "url:" + jsonResponse.item_loop[key].presetParams.favorites_url;

                var image = await this._client.extractArtwork(items[key].url, items[key])

                var icon_name = /([^\/]*).png$/.exec(image);
                if (icon_name)
                    icon_name = icon_name[1];

                if (transfer_playback_titles.includes(items[key].name))
                    icon_name = "transfer";

                // Filter out entries we don't want to show
                if (!itemId && icon_name && config.filteredSpotifyEntries.includes(icon_name)) {
                    data.count--;
                    continue;
                }

                // Replace the spotty images by our own
                if (image && image.includes("Spotty") && icon_name) {
                    var host = config.ip ? config.ip : os.hostname();
                    image = "http://" + host + ":7091/icons/" + icon_name + ".svg"
                }

                data.items.push({
                                   id,
                                   name: decodeURIComponent(items[key].name),
                                   image,
                                   type: items[key].type == "playlist" ? 11 //playlist
                                                                       : isAudio || items[key].isaudio == "1" ? 2 : 1 //folder
                               })
            }
            return data
        }
    }

    this.reset();
  }

  loggingCategory() {
    return this._lc;
  }

  // The events for changes are send by use, don't send them in index.js
  canSendEvents() {
    return true;
  }

  reset(start = 0) {
    this._itemMap = new Map;
    this._itemMap.set(undefined, {
                          total: Infinity,
                          items: [],
                      })
  }

  async get(rootItem, start, length) {
    console.log(this._lc, "GET", start, length, "rootItem: " + rootItem)
    const end = start + (length || 1);

    await this._mutex.runExclusive(async () => {
        let _total, _items = undefined;
        if (this._itemMap.has(rootItem) && this._useCache) {
            let data = this._itemMap.get(rootItem);
            _total = data.total;
            _items = data.items;
        } else {
            _total = Infinity;
            _items = [];
        }

        if (_items.length < _total && _items.length < end && this.get_call) {
            let chunk = await this.get_call(rootItem, start, length || 1)

            //console.log(this._lc, chunk.count, chunk.items.length, JSON.stringify(chunk.items))

            _total = chunk.count

            // With cache enabled we always calculate the complete list here and store it
            // Without we just store the latest result to return it outside of this async function.
            if (this._useCache)
                _items.splice(_items.length, 0, ...chunk.items)
            else
                _items = chunk.items

            this._itemMap.set(rootItem, {
                                  total: _total,
                                  items: _items
                              });
        }
    });

    let {total, items} = this._itemMap.get(rootItem);

    const returnValue = {
      total: total,
      // With cache we need to return the data which was requested from the complete cached data
      // Without cache we just return the data the async function just stored.
      items: this._useCache ? items.slice(start, end) : items,
    };

    console.log(this._lc, "RETURN", returnValue);

    return returnValue;
  }

  async insert(position, ...items) {
    console.log(this._lc, "INSERT", position, ...items)
    if (!this.insert_call) {
        console.error(this._lc, "NOT IMPLEMENTED!")
        return;
    }

    await this.insert_call(position, ...items)
    console.log(this._lc, "DONE");
  }

  async replace(position, ...items) {
     console.log(this._lc, "REPLACE", position, ...items)
     await this.delete(position, 1)
     await this.insert(position, ...items)
     console.log(this._lc, "DONE");
  }

  async move(position, destination) {
    console.log(this._lc, "MOVE", position, destination)
    if (!this.move_call) {
        console.error(this._lc, "NOT IMPLEMENTED!")
        return;
    }

    await this.move_call(position, destination)
    console.log(this._lc, "DONE");
  }

  async delete(position, length) {
    console.log(this._lc, "DELETE", position, length)
    if (!this.delete_call) {
        console.error(this._lc, "NOT IMPLEMENTED!")
        return;
    }
    await this.delete_call(position, length)
    console.log(this._lc, "DONE");
  }

  async clear() {
    console.log(this._lc, "CLEAR")
    if (!this.clear_call) {
        console.error(this._lc, "NOT IMPLEMENTED!")
        return;
    }
    await this.clear_call()
    console.log(this._lc, "DONE");
  }
};
