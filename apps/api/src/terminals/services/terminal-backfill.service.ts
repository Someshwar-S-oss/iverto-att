import { Injectable, Logger } from '@nestjs/common';
import type { M50Session } from '../m50-session';
import { M50Command, parseTimeLog } from '../protocol/m50-protocol';
import { TerminalIngestService } from './terminal-ingest.service';

/** Stop rather than loop forever if a terminal keeps claiming there is more. */
const MAX_RECORDS_PER_RUN = 20_000;

/**
 * How many records to re-read before the cursor when we have to guess.
 *
 * Only used when the device will not say how many logs it holds, which is the
 * one case the search below cannot run. Reading a few records we already have
 * is free — the per-record guard drops them. Reading a few too few is not.
 */
const RESUME_OVERLAP = 16;

/**
 * Recovers attendance logs a terminal buffered while the server was unreachable.
 *
 * The device stores up to 500,000 records locally and keeps streaming from
 * wherever it left off, but anything it tried to send while we were down is
 * only retrievable by pulling it: GetFirstGlog seeks to a position, GetNextGlog
 * walks forward, and a `Fail` result means the log is exhausted.
 */
@Injectable()
export class TerminalBackfillService {
  private readonly logger = new Logger(TerminalBackfillService.name);
  /** Guards against a reconnect starting a second walk over the same device. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly ingest: TerminalIngestService) {}

  async run(session: M50Session): Promise<void> {
    const context = session.requireContext();
    if (this.inFlight.has(context.deviceId)) {
      this.logger.log(`Backfill already running for ${context.serialNo}; skipping`);
      return;
    }
    this.inFlight.add(context.deviceId);

    try {
      await this.walk(session);
    } finally {
      this.inFlight.delete(context.deviceId);
    }
  }

  /**
   * Find the position of the first record we have not already ingested.
   *
   * This exists because the protocol has two numbering schemes and no way to
   * convert between them: `GetFirstGlog` seeks to a 0-based *position* in the
   * device's ring, while the only thing we durably remember is the device's own
   * monotonic *LogID*. Treating one as the other is what silently dropped
   * scans — resuming at "LogID + 1" seeks past the final position on a device
   * whose numbering happens to line up, and lands nowhere near the right record
   * on one whose log has been trimmed. In both cases the device answers `Fail`,
   * which is indistinguishable from "nothing new", so the cursor never advances
   * and the record is lost for good rather than retried.
   *
   * Every record carries its LogID, and LogIDs ascend with position, so the
   * boundary can simply be searched for: about seventeen reads on a device
   * holding a hundred thousand records, and exact rather than estimated.
   *
   * Returns null when the device holds nothing newer than the cursor.
   */
  private async findResumePosition(
    session: M50Session,
    lastLogId: number,
    lastPos: number | null,
  ): Promise<number | null> {
    // No LogCount means no range to search in. Guess, erring backwards: the
    // per-record guard makes re-reading harmless, and under-reading does not
    // announce itself.
    if (lastPos === null) return Math.max(0, lastLogId - RESUME_OVERLAP);
    if (lastPos < 0) return null;

    const logIdAt = async (pos: number): Promise<number | null> => {
      const fields = await session.command(M50Command.GetFirstGlog, { BeginLogPos: pos });
      if (!fields || fields.Result === 'Fail') return null;
      const logId = Number.parseInt(fields.LogID ?? '', 10);
      return Number.isFinite(logId) ? logId : null;
    };

    // Cheap exit: if the newest record is one we have, there is nothing to do.
    const newest = await logIdAt(lastPos);
    if (newest !== null && newest <= lastLogId) return null;

    let low = 0;
    let high = lastPos;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const logId = await logIdAt(mid);
      // An unreadable record tells us nothing about which half to take, so take
      // the lower one: re-reading costs a round trip, skipping costs a scan.
      if (logId === null || logId > lastLogId) high = mid;
      else low = mid + 1;
    }
    return low;
  }

  private async walk(session: M50Session): Promise<void> {
    const context = session.requireContext();

    const posInfo = await session.command(M50Command.GetGlogPosInfo).catch((err) => {
      this.logger.warn(`GetGlogPosInfo failed on ${context.serialNo}: ${err.message}`);
      return null;
    });
    const logCount = Number.parseInt(posInfo?.LogCount ?? '', 10);
    const lastPos = Number.isFinite(logCount) ? logCount - 1 : null;

    // A device with no cursor yet is walked from the start so its existing
    // history is imported.
    let position = 0;
    if (context.lastLogId !== null) {
      const found = await this.findResumePosition(session, context.lastLogId, lastPos);
      if (found === null) {
        this.logger.log(`Terminal ${context.serialNo} has nothing past LogID ${context.lastLogId}`);
        return;
      }
      position = found;
    }

    if (posInfo?.LogCount !== undefined) {
      this.logger.log(
        `Terminal ${context.serialNo} holds ${posInfo.LogCount} logs; ` +
          `cursor at LogID ${context.lastLogId ?? 'none'}, resuming from position ${position}`,
      );
    }

    let fields = await session.command(M50Command.GetFirstGlog, { BeginLogPos: position });
    let imported = 0;
    let skipped = 0;

    while (fields && fields.Result !== 'Fail' && imported + skipped < MAX_RECORDS_PER_RUN) {
      try {
        const log = parseTimeLog(fields);

        // The live stream may have overtaken the walk, and the overlap above
        // deliberately re-reads records we already have, so re-check the cursor
        // per record. This is what makes reading too much harmless.
        if (context.lastLogId !== null && log.logId <= context.lastLogId) {
          skipped++;
        } else {
          await this.ingest.ingestTimeLog(context, log);
          imported++;
        }
      } catch (err) {
        this.logger.warn(
          `Skipping unparseable backfill record from ${context.serialNo}: ${(err as Error).message}`,
        );
        // One unreadable record must not end the walk: the records after it are
        // still wanted, and the position counter can step over it without
        // needing to have understood it.
        if (imported + skipped === 0 && position > 0) {
          // Nothing has parsed yet, so we cannot tell a corrupt record from a
          // bad seek. Stop rather than walk the whole log on a guess.
          break;
        }
      }

      // Advance by position, which we are counting ourselves, rather than by
      // LogID + 1. The two are different namespaces — position is a 0-based
      // offset into the ring, LogID is the device's own monotonic counter — and
      // conflating them is what put the seek past the end in the first place.
      position++;
      if (lastPos !== null && position > lastPos) break;
      fields = await session.command(M50Command.GetNextGlog, { BeginLogPos: position });
    }

    if (imported + skipped >= MAX_RECORDS_PER_RUN) {
      this.logger.warn(
        `Backfill for ${context.serialNo} hit the ${MAX_RECORDS_PER_RUN}-record cap; ` +
          `the remainder will be picked up on the next reconnect`,
      );
    }

    if (imported || skipped) {
      this.logger.log(
        `Backfill for ${context.serialNo} complete: ${imported} imported, ${skipped} already known`,
      );
    }
  }
}
