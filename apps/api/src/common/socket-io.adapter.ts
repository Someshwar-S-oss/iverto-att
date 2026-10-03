import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';
import { redisOptions } from './redis.service';

/**
 * Socket.IO adapter that leaves foreign WebSocket upgrades alone (copied from
 * hostel — mandatory).
 *
 * M50 terminals complete a raw WebSocket handshake on their own path against
 * this same HTTP server. Engine.IO's default `destroyUpgrade` reaps any upgrade
 * it does not recognise after ~1s unless bytes were already written; relying
 * on the handshake winning that race drops terminals under load. M50Server
 * takes over reaping unclaimed upgrades instead.
 *
 * Also installs the Redis adapter so rooms fan out across replicas later.
 */
export class SharedHttpIoAdapter extends IoAdapter {
  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, {
      ...options,
      destroyUpgrade: false,
      path: process.env.WS_PATH || '/socket.io',
    } as ServerOptions);
    if (process.env.SOCKET_REDIS_ADAPTER !== 'false') {
      const pub = new Redis(redisOptions());
      server.adapter(createAdapter(pub, pub.duplicate()));
    }
    return server;
  }
}
