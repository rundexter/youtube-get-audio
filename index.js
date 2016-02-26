// Require Logic
var yt       = require('youtube-audio-stream')
  , fs       = require('fs')
  , path     = require('path')
  , AWS      = require('aws-sdk')
  , s3Stream = require('s3-upload-stream')(new AWS.S3())
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
     * The main entry point for the Dexter module
     *
     * @param {AppStep} step Accessor for the configuration for the step using this module.  Use step.input('{key}') to retrieve input data.
     * @param {AppData} dexter Container for all data used in this workflow.
     */
    run: function(step, dexter) {
        var key    = parseQueryParameters(step.input('url').first().split('?')[1]).v
          , self   = this
          , upload = s3Stream.upload({
              "Bucket"       : "dexter-staging-temp"
              , "Key"        : key + ".mp3"
              , ACL          : "public-read"
              , StorageClass : "REDUCED_REDUNDANCY"
              , ContentType  : "binary/octet-stream"
            });

        // Optional configuration
        upload.maxPartSize(20971520); // 20 MB
        upload.concurrentParts(5);

        // Handle errors.
        upload.on('error', function (err) {
            self.fail(err);
        });

        /* Handle progress. Example details object:
        { 
        ETag         : '"f9ef956c83756a80ad62f54ae5e7d34b"',
        PartNumber   : 5,
        receivedSize : 29671068,
        uploadedSize : 29671068
        }
        */
        upload.on('part', function (details) {
            self.log(details);
        });

        /* Handle upload completion. Example details object:
        { 
        Location : 'https://bucketName.s3.amazonaws.com/filename.ext',
        Bucket   : 'bucketName',
        Key      : 'filename.ext',
        ETag     : '"bf2acbedf84207d696c8da7dbb205b9f-5"'
        }
        */
        upload.on('uploaded', function (details) {
            self.complete({
                url: 'https://s3.amazonaws.com/dexter-staging-temp/'+key+'.mp3'
            });
        });

        process.env.PATH += ':' + path.resolve('.');

        getAudio(key, upload);
    }
};
