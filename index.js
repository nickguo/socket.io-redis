
/**
 * Module dependencies.
 */

var uid2 = require('uid2');
var redis = require('redis').createClient;
var msgpack = require('msgpack-js');
var Adapter = require('socket.io-adapter');
var Emitter = require('events').EventEmitter;
var debug = require('debug')('socket.io-redis');
var async = require('async');

/**
 * Module exports.
 */

module.exports = adapter;

/**
 * Returns a redis Adapter class.
 *
 * @param {String} optional, redis uri
 * @return {RedisAdapter} adapter
 * @api public
 */

function adapter(uri, opts){
  opts = opts || {};

  // handle options only
  if ('object' == typeof uri) {
    opts = uri;
    uri = null;
  }

  // handle uri string
  if (uri) {
    uri = uri.split(':');
    opts.host = uri[0];
    opts.port = uri[1];
  }

  // opts
  var host = opts.host || '127.0.0.1';
  var port = Number(opts.port || 6379);
  var pub = opts.pubClient;
  var sub = opts.subClient;
  var pubsub = opts.pubsubClient;
  var prefix = opts.key || 'socket.io';
  var timeout = opts.timeout || 50;

  // init clients if needed
  if (!pub) pub = redis(port, host);
  if (!sub) sub = redis(port, host, { detect_buffers: true });
  if (!pubsub) pubsub = redis(port, host);

  // this server's key
  var uid = uid2(6);
  var key = prefix + '#' + uid;


  /**
   * Adapter constructor.
   *
   * @param {String} namespace name
   * @api public
   */

  function Redis(nsp){
    Adapter.call(this, nsp);

    this.uid = uid;
    this.prefix = prefix;
    this.pubClient = pub;
    this.subClient = sub;

    var self = this;
    sub.subscribe(prefix + '#' + nsp.name + '#', function(err){
      if (err) self.emit('error', err);
    });

    sub.subscribe(prefix + '#clientrequest', function(err) {
      if (err) self.emit('error', err);
    });

    sub.on('message', this.onmessage.bind(this));
  }

  /**
   * Inherits from `Adapter`.
   */

  Redis.prototype.__proto__ = Adapter.prototype;

  /**
   * Called with a subscription message
   *
   * @api private
   */

  Redis.prototype.onmessage = function(channel, msg){
    // need to determine if broadcast message, or clients message
    var pieces = channel.split('#');

    if (pieces.slice(-1)[0] == "clientrequest") {
      var args = msgpack.decode(msg);
      if (this.nsp.name != args.shift()) return debug("ignore different namespace");
      if (uid == args.shift()) return debug('ignore same uid');
      args.push(null, prefix + '#' + args.shift() + '#clientresponse', true);
      this.clients.apply(this, args);
    }
    else {
      var args = msgpack.decode(msg);
      var packet;

      if (uid == args.shift()) return debug('ignore same uid');

      packet = args[0];

      if (packet && packet.nsp === undefined) {
        packet.nsp = '/';
      }

      if (!packet || packet.nsp != this.nsp.name) {
        return debug('ignore different namespace');
      }

      args.push(true);

      this.broadcast.apply(this, args);
    }
  };

  /**
   * Broadcasts a packet.
   *
   * @param {Object} packet to emit
   * @param {Object} options
   * @param {Boolean} whether the packet came from another node
   * @api public
   */

  Redis.prototype.broadcast = function(packet, opts, remote){
    Adapter.prototype.broadcast.call(this, packet, opts);
    if (!remote) {
      if (opts.rooms) {
        opts.rooms.forEach(function(room) {
          var chn = prefix + '#' + packet.nsp + '#' + room + '#';
          var msg = msgpack.encode([uid, packet, opts]);
          pub.publish(chn, msg);
        });
      } else {
        var chn = prefix + '#' + packet.nsp + '#';
        var msg = msgpack.encode([uid, packet, opts]);
        pub.publish(chn, msg);
      }
    }
  };

  /**
   * Subscribe client to room messages.
   *
   * @param {String} client id
   * @param {String} room
   * @param {Function} callback (optional)
   * @api public
   */

  Redis.prototype.add = function(id, room, fn){
    debug('adding %s to %s ', id, room);
    var self = this;
    this.sids[id] = this.sids[id] || {};
    this.sids[id][room] = true;
    this.rooms[room] = this.rooms[room] || {};
    this.rooms[room][id] = true;
    var channel = prefix + '#' + this.nsp.name + '#' + room + '#';
    sub.subscribe(channel, function(err){
      if (err) {
        self.emit('error', err);
        if (fn) fn(err);
        return;
      }
      if (fn) fn(null);
    });
  };

  /**
   * Unsubscribe client from room messages.
   *
   * @param {String} session id
   * @param {String} room id
   * @param {Function} callback (optional)
   * @api public
   */

  Redis.prototype.del = function(id, room, fn){
    debug('removing %s from %s', id, room);

    var self = this;
    this.sids[id] = this.sids[id] || {};
    this.rooms[room] = this.rooms[room] || {};
    delete this.sids[id][room];
    delete this.rooms[room][id];

    if (this.rooms.hasOwnProperty(room) && !Object.keys(this.rooms[room]).length) {
      delete this.rooms[room];
      var channel = prefix + '#' + this.nsp.name + '#' + room + '#';
      sub.unsubscribe(channel, function(err){
        if (err) {
          self.emit('error', err);
          if (fn) fn(err);
          return;
        }
        if (fn) fn(null);
      });
    } else {
      if (fn) process.nextTick(fn.bind(null, null));
    }
  };

  /**
   * Unsubscribe client completely.
   *
   * @param {String} client id
   * @param {Function} callback (optional)
   * @api public
   */

  Redis.prototype.delAll = function(id, fn){
    debug('removing %s from all rooms', id);

    var self = this;
    var rooms = this.sids[id];

    if (!rooms) return process.nextTick(fn.bind(null, null));

    async.forEach(Object.keys(rooms), function(room, next){
      if (rooms.hasOwnProperty(room)) {
        delete self.rooms[room][id];
      }

      if (self.rooms.hasOwnProperty(room) && !Object.keys(self.rooms[room]).length) {
        delete self.rooms[room];
        var channel = prefix + '#' + self.nsp.name + '#' + room + '#';
        return sub.unsubscribe(channel, function(err){
          if (err) return self.emit('error', err);
          next();
        });
      } else {
        process.nextTick(next);
      }
    }, function(err){
      if (err) {
        self.emit('error', err);
        if (fn) fn(err);
        return;
      }
      delete self.sids[id];
      if (fn) fn(null);
    });
  };

  
  Redis.prototype.clients = function(rooms, fn, channel, remote){
    var self = this;

    Adapter.prototype.clients.call(this, rooms, function(err, sids) {
      if (err) return fn && fn(err);

      sids = sids || [];

      if (remote) {
        pub.publish(channel, msgpack.encode([sids]));
      } else {
        pubsub.pubsub('NUMSUB', prefix + '#clientrequest', function (err, subs) {
          if (err) return fn && fn(err);

          var remaining = subs.pop() - 1;

          //TODO: find a better way to determine timeout.
          //      currently just scales the timeout with the number of remaining subs
          //      at the rate of TIMEOUT per additional sub
          var handle = setTimeout(finish, timeout*remaining);
          var muid = uid2(6);
          var packet = [self.nsp.name, uid, muid, rooms];

          function onclientresponsemessage(channel, message) {
            var pieces = channel.toString().split('#');
            if (pieces.slice(-1)[0] != "clientresponse") {
              return;
            }
            if (pieces.slice(-2)[0] != muid) return debug('ignore different client response');
            var response = msgpack.decode(message);
            sids.push.apply(sids, response[0]);
            --remaining || finish();
          }

          sub.subscribe(prefix + '#' + muid + "#clientresponse", function(err) {
            if (err) self.emit('error', err);
          });

          sub.on('message', onclientresponsemessage);

          function finish(){
            sub.removeListener('message', onclientresponsemessage);
            clearTimeout(handle);
            fn && fn(null, sids);
          }

          pub.publish(prefix + '#clientrequest', msgpack.encode(packet));
        });
      }
    });
  };

  return Redis;
}

