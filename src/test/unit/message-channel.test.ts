import { describe, it, expect } from 'vitest';
import { createMessageChannel } from '../../utils/message-channel';

describe('MessageChannel', () => {
  describe('basic push/iterate flow', () => {
    it('delivers pushed messages through the iterator', async () => {
      const channel = createMessageChannel();
      channel.push('hello');
      channel.push('world');

      const iterator = channel.iterable[Symbol.asyncIterator]();
      const first = await iterator.next();
      const second = await iterator.next();

      expect(first.done).toBe(false);
      expect(first.value.message.content).toBe('hello');
      expect(second.done).toBe(false);
      expect(second.value.message.content).toBe('world');

      channel.close();
    });

    it('returns done: true after consuming and closing', async () => {
      const channel = createMessageChannel();
      channel.push('test');

      const iterator = channel.iterable[Symbol.asyncIterator]();
      // Consume the message first
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value.message.content).toBe('test');

      // Then close and verify done
      channel.close();
      const second = await iterator.next();
      expect(second.done).toBe(true);
    });
  });

  describe('push after close', () => {
    it('ignores messages pushed after close', async () => {
      const channel = createMessageChannel();
      channel.close();
      channel.push('after'); // Should be ignored

      const iterator = channel.iterable[Symbol.asyncIterator]();
      const result = await iterator.next();

      // Should get done immediately since close clears pending and marks done
      expect(result.done).toBe(true);
    });
  });

  describe('close resolves pending iterator', () => {
    it('unblocks a waiting next() call when closed', async () => {
      const channel = createMessageChannel();
      const iterator = channel.iterable[Symbol.asyncIterator]();

      // Start waiting for next message (will block)
      const nextPromise = iterator.next();

      // Close should unblock the pending next()
      channel.close();
      const result = await nextPromise;

      expect(result.done).toBe(true);
    });
  });

  describe('pending queue cleared on close', () => {
    it('clears pending messages when close is called', async () => {
      const channel = createMessageChannel();

      // Push messages without consuming
      channel.push('msg1');
      channel.push('msg2');
      channel.push('msg3');

      // Close should clear the pending queue
      channel.close();

      // Any new iterator should immediately get done
      const iterator = channel.iterable[Symbol.asyncIterator]();
      const result = await iterator.next();

      expect(result.done).toBe(true);
    });
  });

  describe('iterator return()', () => {
    it('return() signals done', async () => {
      const channel = createMessageChannel();
      channel.push('test');

      const iterator = channel.iterable[Symbol.asyncIterator]();
      const returnResult = await iterator.return!();

      expect(returnResult.done).toBe(true);
    });

    it('iterator is done after return() is called', async () => {
      const channel = createMessageChannel();

      const iterator = channel.iterable[Symbol.asyncIterator]();

      // Call return() first
      await iterator.return!();

      // Now get a new iterator - it should see done=true
      const iterator2 = channel.iterable[Symbol.asyncIterator]();
      const result = await iterator2.next();
      expect(result.done).toBe(true);
    });
  });

  describe('message structure', () => {
    it('wraps messages in SDK format', async () => {
      const channel = createMessageChannel();
      channel.push('test message');

      const iterator = channel.iterable[Symbol.asyncIterator]();
      const result = await iterator.next();

      expect(result.value).toEqual({
        type: 'user',
        message: { role: 'user', content: 'test message' },
        parent_tool_use_id: null,
        session_id: '',
      });

      channel.close();
    });
  });
});
