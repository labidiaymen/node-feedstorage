var mongoose = require('mongoose');
var FeedParser = require('feedparser');
var request = require('request');
var Stream = require('stream');
var chardet = require('chardet');
var iconv = require('iconv-lite');

var feedSchema = mongoose.Schema({
    _id:              { type: String, required: true, unique: true },
    title:            String,
    description:      String,
    link:             String,
    xmlUrl:           String,
    date:             { type: Date },
    pubDate:          { type: Date },
    author:           String,
    language:         String,
    image:            { title: String, url: String },
    favicon:          String,
    copyright:        String,
    generator:        String,
    categories:       [String],
    lastModified:     String
});


var Feed = mongoose.model('Feed', feedSchema);

var articleSchema = mongoose.Schema({
    title:            String,
    description:      String,
    link:             String,
    origLink:         String,
    date:             { type: Date },
    pubDate:          { type: Date },
    author:           String,
    guid:             String,
    comments:         String,
    image:            { title: String, url: String },
    categories:       [String],
    source:           { title: String, url: String },
    enclosures:       [{ url: String, type: String, length: String }],
    feed:             { type: String, ref: 'Feed' },
    savedAt:          { type: Date }
});

var Article = mongoose.model('Article', articleSchema);

var timeoutInMs = 10000;
var defaultMongoDbPort = 27017; 
var updateIntervalHandle = null;

function connect(options) {
    options.port = options.port || defaultMongoDbPort;
    options.callback = options.callback || function() {};

    mongoose.connect(options.uri, options.database, options.port);
    
    mongoose.connection.on('error', function(e){
        logError("Could not connect to MongoDB: "+e.message);
        process.exit(1);
    });
    
    mongoose.connection.once('open', function callback () {
        logDebug("Connection to MongoDB was successful.");
        options.callback();
    });
}

function addFeed(url, callback) {
    callback = callback || function() {};

    Feed.count({ _id: url }, function(error, count) {
        if(error != null) {
            logError('Failed to check if feed exists in MongoDB: '+error);
        }
        else {
            if(count == 0) {
                requestAndParseFeed(url, callback);
            }
            else if(count == 1) {
                logWarning('Feed '+url+' already exists in the MongoDB. '
                + 'Skipping adding new feed to the storage.');
            }
            else {
                logError('Multiple documents with same url exist in '
                + 'MongoDB. This should not happen!');
            }
        }
    });
}

function removeFeed(url, callback) {
    callback = callback || function() {};

    Feed.findByIdAndRemove(url, function(error, feedDocument) {
        if(error != null) {
            logError('Failed to find feed to be removed: '+error);
        }
        else if(feedDocument != null) {
            removeArticlesByFeedUrl(url, callback);
        }
        else {
            logWarn('Feed not found with url '+url+'. Skipping removing.');
        }
    });
}

function removeArticlesByFeedUrl(url, callback) {
    Article.remove({ feed: url }, function (error) {
        if(error != null) {
            logError('Failed to find articles to be removed: '+error);
        }
        callback();
    });
}

function removeArticlesOlderThan(days) {
    var oldArticleDate = new Date();
    oldArticleDate.setDate(oldArticleDate.getDate()-days);
    
    Article.remove({ date: { $lt: oldArticleDate } }, function (error) {
        if(error != null) {
            logError('Failed to remove articles older than '+days+': '+error);
        }
    });
}

function requestAndParseFeed(url, callback) {
    var requestObject = createDefaultRequest(url);
    
    Feed.findOne({ _id: url }, 'lastModified', function(error,
        partialFeedDocument) {
        if(error != null) {
            logError('Failed to get feeds Last-Modified from MongoDB: '+
                error);
        }
        else if(partialFeedDocument != null && 
            partialFeedDocument.lastModified != null) {
            requestObject.headers = { 'If-Modified-Since':
                partialFeedDocument.lastModified }
        }
        
        request(requestObject, function(error, response, body) {
            handleResponse(url, error, response, body, callback);
        });
    });
}

function createDefaultRequest(url) {
    return { url: url, timeout: timeoutInMs, encoding: null };
}

function handleResponse(url, error, response, body, callback) {
    if(error != null) {
        logError('Failed to handle HTTP response: '+error);
    }
    else if (response.statusCode == 200) {
        var lastModified = getLastModifiedFromResponseHeaders(
            response.headers);
        body = getBufferAsUtf8Buffer(body);
        
        /* Feedparser no longer supports string, so convert body to stream
         * again.This is a little dirty, but needed because before parsing
         * the body it is a good idea to check http status code and
         * Last-Modified.
         */
        var bodyAsStream = Stream.PassThrough();
        bodyAsStream.write(body);
        bodyAsStream.end();
        
        bodyAsStream.pipe(new FeedParser())
        .on('error', function (error) {
            handleParseError(error, url);
        })
        .on('meta', function (meta) {
            saveOrUpdateFeedMeta(meta, url, lastModified);
        })
        .on('readable', function() {
            var stream = this;
            var article;
            
            while (article = stream.read()) {
                saveOrUpdateArticle(article, url);
            }
            
        })
        .on('end', function() {
            callback();
        });
    }
    else if (response.statusCode == 304) {
    
    }
    else {
        logWarning('HTTP status code received that can not be handled by '
            + 'this module: '+response.statusCode);
    }
}

function getBufferAsUtf8Buffer(buffer) {
    var encoding = chardet.detect(buffer);
    
    if(encoding != 'UTF-8') {
        decodedString = iconv.decode(buffer, encoding);
        buffer = iconv.encode(decodedString, 'utf8');
    }
    
    return buffer;
}

function handleParseError(error, url) {
    logError('Could not parse feed at '+url+'. '+error);
}

function getLastModifiedFromResponseHeaders(headers) {    
    var lastModified = null;
    
    for(var headerName in headers){
        if(headerName.toLowerCase() == 'last-modified') {
            lastModified = headers[headerName];
        }
    }
    
    return lastModified;
}

function saveOrUpdateFeedMeta(meta, url, lastModified) {
    Feed.findOne({ _id: url }, function(error, feedDocument) {
        if(error != null) {
            logError('Failed to get feed from MongoDB: '+error);
        }
        else {
            if(feedDocument == null) {
                saveFeedMeta(meta, url, lastModified);
            }
            else {
                updateFeedMeta(feedDocument, meta, url, lastModified);
            }
        }
    });  
}

function saveFeedMeta(meta, url, lastModified) {
    var feedDocument = createFeedDocument(meta, url, lastModified);
        
    feedDocument.save(function (error, feedDocument) {
        if(error != null) {
            logError('Failed to save feed meta to MongoDB: '+error);
        }
        else {
            logDebug('Added new feed "'+feedDocument._id+'" to MongoDB.');
        }
    });
}

function updateFeedMeta(feedDocument, meta, lastModified) {
    if(feedRequiresUpdate(feedDocument, meta, lastModified)) {
        feedDocument.title = meta.title;
        feedDocument.description = meta.description;
        feedDocument.link = meta.link;
        feedDocument.xmlUrl = meta.xmlUrl;
        feedDocument.date = meta.date;
        feedDocument.pubDate = meta.pubDate;
        feedDocument.author = meta.author;
        feedDocument.language = meta.language;
        feedDocument.image = meta.image;
        feedDocument.favicon = meta.favicon;
        feedDocument.copyright = meta.copyright;
        feedDocument.generator = meta.generator;
        feedDocument.categories = meta.categories;
        feedDocument.lastModified = lastModified;
    
        feedDocument.save(function (error, feedDocument) {
            if(error != null) {
                logError('Failed to update feed meta to MongoDB: '+error);
            }
            else {
                logDebug('Updated feed "'+feedDocument._id+'" in MongoDB.');
            }
        });
    } 
}

function feedRequiresUpdate(feedDocument, meta, lastModified) {
    var requiresUpdate = false;
    
    if(feedDocument.title != meta.title &&
        feedDocument.description != meta.description &&
        feedDocument.link != meta.link &&
        feedDocument.xmlUrl != meta.xmlUrl &&
        feedDocument.author != meta.author &&
        feedDocument.language != meta.language &&
        feedDocument.image.title != meta.image.title &&
        feedDocument.image.url != meta.image.url &&
        feedDocument.favicon != meta.favicon &&
        feedDocument.copyright != meta.copyright &&
        feedDocument.generator != meta.generator &&
        JSON.stringify(feedDocument.categories) !=
            JSON.stringify(meta.categories) &&
        feedDocument.lastModified != lastModified) {        
        requiresUpdate = true;
    }
    
    return requiresUpdate;
}

function createFeedDocument(meta, url, lastModified) {
    return new Feed({ _id: url, title: meta.title,
        description: meta.description, link: meta.link, xmlUrl: meta.xmlUrl,
        date: meta.date, pubDate: meta.pubDate, author: meta.author,
        language: meta.language, image: meta.image, favicon: meta.favicon,
        copyright: meta.copyright, generator: meta.generator,
        categories: meta.categories, lastModified: lastModified });
}

function saveOrUpdateArticle(article, url) {
    Article.findOne({ guid: article.guid, feed: url }, function(error,
        articleDocument) {
        if(error != null) {
            logError('Failed to get article from MongoDB: '+error);
        }
        else {
            if(articleDocument == null) {
                saveArticle(article, url);
            }
            else {
                updateArticle(articleDocument, article);
            }
        }
    });  
}

function saveArticle(article, url) {
    var articleDocument = createArticleDocument(article, url);
        
    articleDocument.save(function (error, articleDocument) {
        if(error != null) {
            logError('Failed to save article to MongoDB: '+error);
        }
        else {
            logDebug('Added new article "'+articleDocument.guid
            + '" to MongoDB.');
        }
    });
}

function updateArticle(articleDocument, article) {
    if(articleRequiresUpdate(articleDocument, article)) {    
        articleDocument.title = article.title;
        articleDocument.description = article.description;
        articleDocument.link = article.link;
        articleDocument.xmlUrl = article.xmlUrl;
        articleDocument.date = article.date;
        articleDocument.pubDate = article.pubDate;
        articleDocument.author = article.author;
        articleDocument.language = article.language;
        articleDocument.image = article.image;
        articleDocument.favicon = article.favicon;
        articleDocument.copyright = article.copyright;
        articleDocument.generator = article.generator;
        articleDocument.categories = article.categories;
    
        articleDocument.save(function (error, feedDocument) {
            if(error != null) {
                logError('Failed to update article to MongoDB: '+error);
            }
            else {
                logDebug('Updated article "'+articleDocument.guid
                +'" in MongoDB.');
            }
        });
    } 
}

function articleRequiresUpdate(articleDocument, article) {
    var requiresUpdate = false;
    
    if(articleDocument.title != article.title &&
        articleDocument.description != article.description &&
        articleDocument.link != article.link &&
        articleDocument.origLink != article.origLink &&
        articleDocument.author != article.author &&
        articleDocument.guid != article.guid &&
        articleDocument.comments != article.comments &&
        articleDocument.image.title != article.image.title &&
        articleDocument.image.url != article.image.url &&
        JSON.stringify(articleDocument.categories) !=
            JSON.stringify(article.categories) &&
        articleDocument.source.title != article.source.title &&
        articleDocument.source.url != article.source.url &&
        articleDocument.enclosures.url != article.enclosures.url &&
        articleDocument.enclosures.type != article.enclosures.type &&
        articleDocument.enclosures.length != article.enclosures.length) {        
        requiresUpdate = true;
    }
    
    return requiresUpdate;
      
}

function createArticleDocument(article, url) {
    return new Article({ title: article.title,
        description: article.description, link: article.link,
        origLink: article.origLink, date: article.date,
        pubDate: article.pubDate, author: article.author, guid: article.guid,
        comments: article.comments, image: article.image,
        categories: article.categories, source: article.source,
        enclosures: article.enclosures, feed: url, savedAt: new Date() });
}

function updateDatabase() {
    Feed.find(function(error, feedDocuments) {
        if(error != null) {
            logError('Failed to get feeds from MongoDB: '+error);
        }
        else {
            feedDocuments.forEach(function(feedDocument) {
                requestAndParseFeed(feedDocument._id, function() {});
            });
        }
    });
}

function updateDatabaseAtInterval(milliseconds) {
    if(updateIntervalHandle == null) {
        updateIntervalHandle = setInterval(updateDatabase, milliseconds);
    }
    else {
        logWarning('Database update interval already set. Skipping.');
    }
}

function stopUpdateDataBaseAtInterval() {
    if(updateIntervalHandle != null) {
        clearInterval(updateIntervalHandle);
        updateIntervalHandle = null;
    }
}

function getArticlesByKeyword(keyword, options, callback) {
    if(typeof callback == 'undefined' && typeof options == 'function') {
        callback = options;
        options = {};
    }
    
    var query = createQueryForArticles(keyword, options);
    executeArticleQuery(query, callback);
}

function getArticlesByKeywordArray(keywords, options, callback) {
    var keyword = '('+keywords.join('|')+')'; 
    getArticlesByKeyword(keyword, options, callback);
}

function createQueryForArticles(keyword, options) {
    var allowedCharsBeforeAndAfter = '\\s|\\.|\,|\!|\\?|:|-|_|\'|"|@|#|\$|'
        +'%|&|\\(|\\)|\\[|\\]|{|}|\\+'; 
    var searchTerm = new RegExp('.*(^|'+allowedCharsBeforeAndAfter+')+'
        +keyword+'('+allowedCharsBeforeAndAfter+'|$)+.*', 'i');
    var criteria = { $or: [ { title: searchTerm }, { description:
            searchTerm }, { author: searchTerm } ] };
                                    
    if(typeof options.from != 'undefined') {
        criteria.savedAt = criteria.savedAt || {};
        criteria.savedAt.$gte = options.from;
    }
    
    if(typeof options.to != 'undefined') {
        criteria.savedAt = criteria.savedAt || {};
        criteria.savedAt.$lte = options.to;
    }
        
    var query = Article.find(criteria);
    
    if(typeof options.limit != 'undefined') {
        query.limit(options.limit);
    }

    query.sort({savedAt: 'desc'});
    query.populate('feed', 'title');

    return query;
}

function executeArticleQuery(query, callback) {
    query.exec(function (error, articleDocuments) {
        if(error != null) {
            logError('Failed to get articles from MongoDB: '+error);
        }
        else {
            callback(articleDocuments);
        }
    });  
}

function logDebug(message) {
    console.log(getTimeStampForLog()+' [DEBUG] '+message);
}

function logWarning(message) {
    console.warn(getTimeStampForLog()+' [WARN] '+message);
}

function logError(message) {
    console.error(getTimeStampForLog()+' [ERROR] '+message);
}

function getTimeStampForLog() {
    return new Date().toUTCString();
}

exports.connect = connect;
exports.addFeed = addFeed;
exports.updateDatabase = updateDatabase;
exports.updateDatabaseAtInterval = updateDatabaseAtInterval;
exports.stopUpdateDataBaseAtInterval = stopUpdateDataBaseAtInterval;
exports.getArticlesByKeyword = getArticlesByKeyword;
exports.getArticlesByKeywordArray = getArticlesByKeywordArray;
exports.removeFeed = removeFeed;
exports.removeArticlesOlderThan = removeArticlesOlderThan;
