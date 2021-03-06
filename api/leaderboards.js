var config = require(__dirname + "/config.js"),
    db = require(__dirname + "/database.js"),
    md5 = require(__dirname + "/md5.js"),
    utils = require(__dirname + "/utils.js"),
    mongodb = require("mongodb"),
    objectid = mongodb.BSONPure.ObjectID,
    datetime = require(__dirname + "/datetime.js"),
    errorcodes = require(__dirname + "/errorcodes.js").errorcodes;

var leaderboards = module.exports = {

    /**
     * Lists scores from a leaderboard table
     * @param options:  table, url, highest, mode, page, perpage, filters ass. array, friendslist,
     * @param callback function (error, errorcode, numscores, scores)
     */
    list:function (options, callback) {

        // defaults
        if(!options.page) {
            options.page = 1;
        }

        if(!options.perpage) {
            options.perpage = 20;
        }

        if(!options.highest && !options.lowest) {
            options.highest = true;
        }

        var query = {
            
            filter: {
                publickey: options.publickey,
                table: options.table
            },
            
            limit: options.perpage,
            skip: (options.page - 1) * options.perpage,
            sort: {},
            cache: true,
            cachetime: 120
        };

        // per-source leaderboards, originally this
        // was to separate websites but you could use it as
        // any additional string filter with a database index
        if(options.source) {
            query.filter.source = utils.baseurl(options.source);
        }
        
        // filters for custom fields
        for(var x in options.filters) {
            query.filter["fields." + x] = options.filters[x];
        }
        
        // filtering for friends, maximum 100 and we can't tell what is
        // the 100 important ones so that has to be determined on the
        // client side
        if(options.friendslist) {
            if(options.friendslist.length > 100) {
                options.friendslist.length = 100;
            }

            query.filter.playerid = { $in: options.friendslist };
        }

        if(options.playerid) {
            query.filter.playerid = options.playerid;
        }
        
        // date mode
        switch(options.mode) {
            case "today":
                query.filter.date = {"$gte": datetime.now - (24 * 60 * 60)};
                break;
            
           case "last7days":
               query.filter.date = {"$gte": (datetime.now - (7 * 24 * 60 * 60))};
                break;
            
            case "last30days":
                query.filter.date = {"$gte": (datetime.now - (30 * 24 * 60 * 60))};
                break;
        }
        
        // sorting
        if(options.mode == "newest") {
            query.sort = { date: -1 };
        } else {
            query.sort = { points: options.highest || !options.lowest ? -1 : 1 };
        }

        // the scores
        db.playtomic.leaderboard_scores.getAndCount(query, function(error, scores, numscores){

            if(error) {
                //console.log(JSON.stringify(query));
                callback("unable to load scores: " + error + " (api.leaderboards.list:104)", errorcodes.GeneralError);
                return;
            }

            // clean up scores
            if(!scores) {
                scores = [];
            }

            callback(null, errorcodes.NoError, numscores, clean(scores, query.skip));
        });
    },

    /**
     * Saves a score
     * @param options: url, name, points, auth, playerid, table, highest, allowduplicates, customfields ass. array
     * @param callback function(error, errorcode)
     */
    save: function(options, callback) {

        // defaults
        if(!options.source) {
            options.source = "";
        }

        if(!options.name) {
            callback("no name (" + options.name + ")", errorcodes.InvalidName);
            return;
        }

        if(!options.table) {
            callback("no table name (" + options.table + ")", errorcodes.InvalidName);
            return;
        }

        if(!options.highest && !options.lowest) {
            //console.log("assuming highest");
            options.highest = true;
        }

        // small cleanup
        var score = {};

        // fields that just aren't relevant, by doing it this way it's easier to extend because you can
        // just add more fields directly in your game and they will end up in your scores and returned
        // to your game
        var exclude = ["allowduplicates", "highest", "lowest", "numfields", "section", "action",
                        "ip", "date", "url", "rank", "points", "page", "perpage", "global", "filters"];

        for(var x in options) {
            if(exclude.indexOf(x) > -1) {
                continue;
            }

            score[x] = options[x];
        }

        score.hash = md5(options.ip + "." +
                         options.table + "." +
                         options.name + "." +
                         options.playerid + "." +
                         (options.highest || false) + "." +
                         (options.lowest || false) + "." +
                         options.source);
        score.points = options.points;
        score.date = datetime.now;

        //console.log(JSON.stringify(score));

        // check bans

        // insert
        if(options.hasOwnProperty("allowduplicates") && options.allowduplicates) {

            //console.log("inserting");

            db.playtomic.leaderboard_scores.insert({doc: score, safe: true}, function(error, item) {

                if(error) {
                    callback("unable to insert score: " + error + " (api.leaderboards.save:192)", errorcodes.GeneralError);
                    return;
                }

                callback(null, errorcodes.NoError);
            });

            return;
        }

        // update if it's better or worse

        // check for duplicates, by default we will assume highest unless
        // lowest is explicitly specified
        var dupequery = {
            filter: {
                hash: score.hash
            },
            limit: 1,
            cache: false,
            sort: options.highest ? {score : -1 } : {score: 1 }
        };

        db.playtomic.leaderboard_scores.get(dupequery, function(error, items) {

            // no duplicates
            if(items.length == 0) {

                db.playtomic.leaderboard_scores.insert({doc: score}, function(error, item) {

                    if(error) {
                        callback("unable to insert score: " + error + " (api.leaderboards.save:212)", errorcodes.GeneralError);
                        return;
                    }

                    callback(null, errorcodes.NoError);
                });

                return;
            }

            // check if the new score is higher or lower
            var dupe = items[0];

            if((dupe.points <= score.points && options.highest) || (dupe.points >= score.points && options.lowest)) {

                var query = {
                    filter: { _id: dupe._id },
                    update: { date: options.date, points: options.points, fields: options.fields },
                    doc: dupe
                };

                db.playtomic.leaderboard_scores.update(query, function(error, item) {

                    if(error) {
                        callback("unable to update score: " + error + " (api.leaderboards.save:240)", errorcodes.GeneralError);
                        return;
                    }

                    callback(null, errorcodes.NoError);
                });
            } else {
                //console.log("rejecting");
                callback(null, errorcodes.NotBestScore);
            }
        });
    },

    saveAndList: function(options, callback) {

        leaderboards.save(options, function(error, errorcode) {

            if(error) {
                callback(error + " (api.leaderboards.saveAndList:232)", errorcode);
                return;
            }

            if(options.playerid && options.excludeplayerid) {
                delete(options.playerid);
                delete(options.excludeplayerid);
            }

            // get scores before or after
            var query = {
                filter: {
                    publickey: options.publickey,
                    table: options.table
                },
                sort: options.highest ? {score : -1 } : {score: 1 },
                cache: true,
                cachetime: 120
            };

            if(options.highest || !options.lowest) {
                query.filter.points = {"$gte": options.points};
            } else {
                query.filter.points = {"$lte": options.points};
            }

            for(var x in options.fields) {
                query.filter["fields." + x] = options.fields[x];
            }

            if(options.friendslist) {
                if(options.friendslist.length > 100) {
                    options.friendslist.length = 100;
                }

                query.filter.playerid = { $in: options.friendslist }

            }

            var serrorcode = errorcode;

            db.playtomic.leaderboard_scores.count(query, function(error, numscores) {

                if(error) {
                    callback(error + " (api.leaderboards.saveAndList:276)", errorcode);
                    return;
                }

                var page = Math.floor(numscores / options.perpage);
                var rank = page * options.perpage + 1;

                leaderboards.list(options, function(error, errorcode, numscores, scores) {

                    if(error) {
                        callback(error + " (api.leaderboards.saveAndList:293)", errorcode);
                        return;
                    }

                    if(serrorcode > 0) {
                        errorcode = serrorcode;
                    }

                    // clean up scores
                    if(!scores) {
                        scores = [];
                    }

                    callback(null, errorcode, numscores, clean(scores, rank));
                })
            });
        });
    }
};

function clean(scores, baserank) {

    for(var i=0; i<scores.length; i++) {

        var score = scores[i];

        for(var x in score) {
            if(typeof(score[x]) == "String") {
                score[x] = utils.unescape(score[x]);
            }
        }

        for(var x in score.fields) {
            if(typeof(score.fields[x]) == "String") {
                score.fields[x] = utils.unescape(score.fields[x]);
            }
        }

        score.rank = baserank + i + 1;
        score.scoreid = score._id;
        delete score._id;
        delete score.hash;
    }

    return scores;
}