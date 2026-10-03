import { Test } from '@nestjs/testing';
import { TerminalBackfillService } from './terminal-backfill.service';
import { TerminalIngestService } from './terminal-ingest.service';
import { M50Command } from '../protocol/m50-protocol';
import type { M50DeviceContext } from '../m50-session';

const context = (lastLogId: number | null): M50DeviceContext => ({
  deviceId: 'dev-1',
  tenantId: 'tenant-1',
  siteId: 'site-1',
  serialNo: 'DJ20250307014',
  timeZone: 'Asia/Kolkata',
  direction: 'IN',
  gateName: 'Main',
  terminalType: 'F500',
  lastLogId,
});

describe('TerminalBackfillService', () => {
  let service: TerminalBackfillService;
  let ingest: { ingestTimeLog: jest.Mock };

  const ingestedLogIds = () => ingest.ingestTimeLog.mock.calls.map(([, log]: [any, any]) => log.logId);

  async function build() {
    ingest = { ingestTimeLog: jest.fn().mockResolvedValue({ enqueued: true }) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        TerminalBackfillService,
        { provide: TerminalIngestService, useValue: ingest },
      ],
    }).compile();
    service = moduleRef.get(TerminalBackfillService);
  }

  function device(count: number, lastLogId: number | null, firstLogId = 1) {
    const ctx = context(lastLogId);
    const seeks: number[] = [];
    const command = jest.fn(async (name: string, fields: Record<string, unknown> = {}) => {
      if (name === M50Command.GetGlogPosInfo) return { Result: 'OK', LogCount: String(count) };
      if (name === M50Command.GetFirstGlog || name === M50Command.GetNextGlog) {
        const pos = Number(fields.BeginLogPos);
        seeks.push(pos);
        if (pos < 0 || pos >= count) return { Result: 'Fail' };
        return {
          Result: 'OK',
          LogID: String(pos + firstLogId),
          UserID: '1',
          Time: '2026-08-15-T07:19:24Z',
          Action: 'FACE',
          AttendStat: 'DutyOff',
        };
      }
      return { Result: 'OK' };
    });
    return { session: { command, requireContext: () => ctx } as any, seeks };
  }

  beforeEach(build);

  it('imports the whole log on a device we have never read', async () => {
    const { session } = device(3, null);
    await service.run(session);
    expect(ingestedLogIds()).toEqual([1, 2, 3]);
  });

  it('picks up the newest record instead of seeking past the end of the log', async () => {
    // The field failure this guards, from a real terminal: 37 records held,
    // cursor at LogID 36. Resuming at "LogID + 1" seeks to position 37, which
    // does not exist, so the device answers Fail — indistinguishable from
    // "nothing new". LogID 37 is sitting at position 36 and is never read, and
    // because the cursor never advances past it, never will be.
    const { session } = device(37, 36);

    await service.run(session);

    expect(ingestedLogIds()).toEqual([37]);
  });

  it('finds the resume point without reading the whole log', async () => {
    // The search is what makes correctness affordable: a device can hold half a
    // million records, and re-reading them on every reconnect - this terminal
    // drops its socket regularly - is not an option.
    const { session, seeks } = device(1000, 995);

    await service.run(session);

    expect(ingestedLogIds()).toEqual([996, 997, 998, 999, 1000]);
    expect(seeks.length).toBeLessThan(30);
  });

  it('does not skip records on a device whose log has been trimmed', async () => {
    // Positions 0-9 carry LogIDs 100-109: the two namespaces are far apart, and
    // anything that treats a LogID as a position lands nowhere near the record
    // it wanted.
    const { session } = device(10, 104, 100);

    await service.run(session);

    expect(ingestedLogIds()).toEqual([105, 106, 107, 108, 109]);
  });

  it('stops at the end of the log rather than probing past it', async () => {
    const { session, seeks } = device(5, null);
    await service.run(session);
    expect(Math.max(...seeks)).toBeLessThanOrEqual(4);
  });

  it('does nothing when the cursor is already at the newest record', async () => {
    const { session } = device(37, 37);
    await service.run(session);
    expect(ingest.ingestTimeLog).not.toHaveBeenCalled();
  });

  it('will not start a second walk over a device already being walked', async () => {
    const { session } = device(3, null);
    await Promise.all([service.run(session), service.run(session)]);
    expect(ingestedLogIds()).toEqual([1, 2, 3]);
  });
});
