var http = require('http').Server;
var io = require('socket.io');
var ioc = require('socket.io-client');
var expect = require('expect.js');
var async = require('async');
var redis = require('redis');
var redisAdapter = require('../');


function client(srv, nsp, opts){
  if ('object' == typeof nsp) {
    opts = nsp;
    nsp = null; }
  var addr = srv.address();
  if (!addr) {
    addr = srv.listen().address();
  }
  var url = 'ws://' + addr.address + ':' + addr.port + (nsp || '');
  return ioc(url, opts);
}

describe('socket.io-redis', function(){
  describe('broadcast', function(){
    beforeEach(function(done){
      this.redisClients = [];
      this.socket_servers = []
      var self = this;

      async.times(2, function(n, next){
        var pub = redis.createClient();
        var sub = redis.createClient(null, null, {detect_buffers: true});
        var srv = http();
        var sio = io(srv, {adapter: redisAdapter({pubClient: pub, subClient: sub})});
        self.redisClients.push(pub, sub);
        self.socket_servers.push(sio);

        srv.listen(function(){
          ['/', '/nsp'].forEach(function(name){
            sio.of(name).on('connection', function(socket){
              socket.on('join', function(callback){
                socket.join('room', callback);
              });

              socket.on('leave', function(callback){
                socket.leave('room', callback);
              });

              socket.on('socket broadcast', function(data){
                socket.broadcast.to('room').emit('broadcast', data);
              });

              socket.on('namespace broadcast', function(data){
                sio.of('/nsp').in('room').emit('broadcast', data);
              });

              socket.on('request', function(data){
                socket.emit('reply', data);
              });
            });
          });

          async.parallel([
            function(callback){
              async.times(2, function(n, next){
                var socket = client(srv, '/nsp', {forceNew: true});
                // FIXME ---- temporarily log the socket id to console after socket creation
                console.log("socket id is: " + socket.id);
                // ------------------------
                socket.on('connect', function(){
                  socket.emit('join', function(){
                    next(null, socket);
                  });
                });
              }, callback);
            },
            function(callback){
              // a socket of the same namespace but not joined in the room.
              var socket = client(srv, '/nsp', {forceNew: true});
              socket.on('connect', function(){
                socket.on('broadcast', function(){
                  throw new Error('Called unexpectedly: different room');
                });
                callback();
              });
            },
            function(callback){
              // a socket joined in a room but for a different namespace.
              var socket = client(srv, {forceNew: true});
              socket.on('connect', function(){
                socket.on('broadcast', function(){
                  throw new Error('Called unexpectedly: different namespace');
                });
                socket.emit('join', function(){
                  callback();
                });
              });
            }
          ], function(err, results){
            next(err, results[0]);
          });
        });
      }, function(err, sockets){
        self.sockets = sockets.reduce(function(a, b){ return a.concat(b); });
        done(err);
      });
    });

    afterEach(function(){
      this.redisClients.forEach(function(client){
        client.quit();
      });
    });

    it('should broadcast from a socket', function(done){
      async.each(this.sockets.slice(1), function(socket, next){
        socket.on('broadcast', function(message){
          expect(message).to.equal('hi');
          next();
        });
      }, done);

      var socket = this.sockets[0];
      socket.on('broadcast', function(){
        throw new Error('Called unexpectedly: same socket');
      });
      socket.emit('socket broadcast', 'hi');
    });

    it('should broadcast from a namespace', function(done){
      async.each(this.sockets, function(socket, next){
        socket.on('broadcast', function(message){
          expect(message).to.equal('hi');
          next();
        });
      }, done);

      this.sockets[0].emit('namespace broadcast', 'hi');
    });

    it('should reply to one client', function(done){
      this.sockets.slice(1).forEach(function(socket){
        socket.on('reply', function(message){
          throw new Error('Called unexpectedly: other socket');
        });
      });

      this.sockets[0].on('reply', function(message){
        expect(message).to.equal('hi');
        done();
      });
      this.sockets[0].emit('request', 'hi');
    });

    it('should not send message for clients left the room', function(done){
      var self = this;

      async.each(this.sockets, function(socket, next){
        socket.on('broadcast', function(message){
          throw new Error('Called unexpectedly: client already left the room');
        });
        socket.emit('leave', next);
      }, function (err) {
        self.sockets[0].emit('namespace broadcast', 'hi');
        done();
      });
    });

    it('should unsubscribe from the channel if there are no more room members', function(done){
      var self = this;

      async.each(this.sockets, function(socket, next){
        socket.emit('leave', next);
      }, function (err) {
        var pub = self.redisClients[0];
        pub.pubsub('numsub', 'socket.io#/nsp#room#', function (err, subscriptions) {
          expect(parseInt(subscriptions[1])).to.be(0);
          done(err);
        });
      });
    });

    it('should unsubscribe from the channel if clients have disconnected', function(done){
      var self = this;

      setTimeout(function () {
        async.each(self.sockets, function(socket, next){
          socket.once('disconnect', next);
          socket.disconnect();
        }, function (err) {
          setTimeout(function () {
            var pub = self.redisClients[0];

            pub.pubsub('numsub', 'socket.io#/nsp#room#', function (err, subscriptions) {
              expect(parseInt(subscriptions[1])).to.be(0);
              done(err);
            });
          }, 20);
        });
      }, 20);
    });

    //piggy-back the clients api test off of what was already created for broadcast
    describe('clients', function() {
      it('should get a list of client sids', function(done){
        console.log("\nRunning clients api test\n");
        var socket_ids = this.sockets.map(function(socket) {
          return socket.id;
        });
        console.log("\nFollowing are the current socket-ids:");
        console.dir(socket_ids);

        async.each(this.socket_servers, function(socket_server,next) {
          socket_server.of('/nsp').in('room').clients(function(err, sids) {
            console.log(sids)
          });
        });

        done(new Error("clients test not complete"));

      });
    });

  });

});
