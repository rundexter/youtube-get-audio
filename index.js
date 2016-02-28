// Require Logic
var yt       = require('youtube-audio-stream')
  , fs       = require('fs')
  , path     = require('path')
  , dropbox  = require('dropbox')
  , stream   = require('stream')
  , q        = require('q')
  , _        = require('lodash')
;

function getAudio(id, writeStream) {
    var requestUrl = 'http://youtube.com/watch?v=' + id;
    try {
        yt(requestUrl).pipe(writeStream);
    } catch (exc) {
        console.error(exc);
    }
}

function parseQueryParameters(str) {
    return str.replace(/(^\?)/,'').split("&").map(function(n){return n = n.split("="),this[n[0]] = n[1],this;}.bind({}))[0];
}

module.exports = {
    /**
     *  Inits the class
     */
    init: function() {
        this.receivedBuffers = [];
        this.receivedBuffersLength = 0;
        this.partSizeThreshhold = 5242880;
    }

    /**
     *  Cache contents
     *
     *  @param {Buffer} incomingBuffer - chunk to add to our cache
     */
    , absorbBuffer: function(incomingBuffer) {
        this.receivedBuffers.push(incomingBuffer);
        this.receivedBuffersLength += incomingBuffer.length;
    }
    
    /**
     *  Upload cache contents
     */
    , upload: function() {
        var self     = this
          , deferred = q.defer()
        ;

        if(!this.receivedBuffersLength) return deferred.resolve();

        self.log('uploading chunk', this.receivedBuffersLength);
        this.client.resumableUploadStep(
            Buffer.concat(this.receivedBuffers, this.receivedBuffersLength)
            , this.cursor
            , function(err, _cursor) {
                self.log('uploaded chunk', self.file);
                self.cursor = _cursor;
                return err
                   ? deferred.reject(err)
                   : deferred.resolve()
                ;
            }
        );

        this.receivedBuffers.length = 0;
        this.receivedBuffersLength = 0;

        return deferred.promise;
    }

    /**
     * The main entry point for the Dexter module
     *
     * @param {AppStep} step Accessor for the configuration for the step using this module.  Use step.input('{key}') to retrieve input data.
     * @param {AppData} dexter Container for all data used in this workflow.
     */
    , run: function(step, dexter) {
        var urls    = step.input('url')
          , self   = this
          , client = new dropbox.Client(
              {token: dexter.provider('dropbox').credentials('access_token')}
          )
          , file_folder = step.input('file_folder').first()
          , writable = new stream.Writable({
              highWaterMark: 4194304
          })
          , cursor = null
        ;

        this.client = client;

        writable._write = function(chunk, encoding, next) {
            self.absorbBuffer(chunk);

            if(self.receivedBuffersLength < self.partSizeThreshhold) {
                next();
            } else {
                self.upload()
                  .then(function() {
                      next();
                  })
                  .catch(function(err) {
                      self.fail(err);
                  });
            }
        };


        // Handle errors.
        writable.on('error', function (err) {
            console.error(err);
            self.fail(err);
        });

        writable.on('finish', function (details) {
            self
              .upload()
              .then(function() {
                  var makeUrl               = q.nbind(client.makeUrl, client, self.file, {downloadHack: true})
                    , resumableUploadFinish = q.nbind(client.resumableUploadFinish, client)
                  ;

                  resumableUploadFinish(self.file, self.cursor)
                    .then(function(result) { 
                        self.state = {
                            length: result.size
                            , type: result.mimeType
                        };
                        return makeUrl(); 
                    })
                    .then(self.done.bind(self)) 
                    .catch(self.fail.bind(self))
                    .done()
                  ;

                  //client.resumableUploadFinish(self.file, self.cursor, function(err, stat) {
                  //    return err
                  //      ? self.fail(err)
                  //      : self.complete(stat);
                  //});
              })
              .catch(function(err) {
                  self.fail(err);
              });
        });

        //modify path for local version of ffmpeg
        process.env.PATH += ':' + __dirname;

        var lastIndexKey = step.config('id') + '_lastIndex'
          , lastIndex    = dexter.global(lastIndexKey, 0)
          , url, key, file
        ;

        console.log('lastIndex', lastIndex);

        url          = urls[lastIndex];
        key          = parseQueryParameters(url.split('?')[1]).v;
        this.file    = path.join(file_folder, key+'.mp3');
        this.lastRun = lastIndex >= (urls.length - 1);
        this.resultsKey = step.config('id') + '_results';
        this.dexter     = dexter;

        getAudio(key, writable);

        //setup next index
        dexter.setGlobal(lastIndexKey, lastIndex+1);
    }
    , done: function(urlResult) {
        var results = this.dexter.global(this.resultsKey, []);
        console.log(results);

        results.push({
            url      : urlResult.url
            , length : _.get(this, 'state.length')
            , type   : _.get(this, 'state.type')
        });
        
        if(this.lastRun) {
            this.complete(results);
        } else {
            this.dexter.setGlobal(this.resultsKey, results);
            this.replay();
        }
    }
};
