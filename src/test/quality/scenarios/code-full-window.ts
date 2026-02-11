/**
 * Full-window code scenarios for quality evaluation.
 *
 * Each scenario uses an anchor document of ~9,000 characters, representing a
 * realistic, medium-complexity source file. The cursor is placed at a natural
 * editing point inside a function body, with substantial context on both sides.
 *
 * Anchor C: React data table component (TypeScript/TSX)
 * Anchor D: Python async data pipeline
 */
import { TestScenario } from '../judge';

// ── Anchor C: React data table component ─────────────────────────────
//
// A generic DataTable component with sorting, filtering, pagination, and
// row selection. Uses hooks for state management. ~9,000 chars total.

const anchorC_prefix_1 = `import React, { useState, useMemo, useCallback, useEffect } from 'react';

// ── Types ────────────────────────────────────────────────────────────

interface Column<T> {
  key: keyof T & string;
  label: string;
  sortable?: boolean;
  width?: number;
  render?: (value: T[keyof T], row: T) => React.ReactNode;
}

interface PaginationState {
  page: number;
  pageSize: number;
}

interface SortState {
  column: string | null;
  direction: 'asc' | 'desc';
}

interface FilterState {
  searchText: string;
  activeFilters: Record<string, string[]>;
}

interface DataTableProps<T extends { id: string | number }> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  defaultPageSize?: number;
  pageSizeOptions?: number[];
  onRowClick?: (row: T) => void;
  filterableColumns?: (keyof T & string)[];
  emptyMessage?: string;
  stickyHeader?: boolean;
}

function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function matchesSearch<T>(row: T, columns: Column<T>[], text: string): boolean {
  if (!text) return true;
  const lower = text.toLowerCase();
  return columns.some((col) => {
    const value = row[col.key];
    return value != null && String(value).toLowerCase().includes(lower);
  });
}

function matchesFilters<T>(row: T, activeFilters: Record<string, string[]>): boolean {
  return Object.entries(activeFilters).every(([key, values]) => {
    if (values.length === 0) return true;
    return values.includes(String(row[key as keyof T]));
  });
}

function getUniqueValues<T>(data: T[], key: keyof T & string): string[] {
  const seen = new Set<string>();
  for (const row of data) {
    const val = row[key];
    if (val != null) seen.add(String(val));
  }
  return Array.from(seen).sort();
}

// ── Main component ───────────────────────────────────────────────────

export function DataTable<T extends { id: string | number }>({
  columns,
  data,
  loading = false,
  defaultPageSize = 25,
  pageSizeOptions = [10, 25, 50, 100],
  onRowClick,
  filterableColumns = [],
  emptyMessage = 'No data available',
  stickyHeader = false,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState>({ column: null, direction: 'asc' });
  const [filter, setFilter] = useState<FilterState>({
    searchText: '',
    activeFilters: {},
  });
  const [selectedRows, setSelectedRows] = useState<Set<string | number>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  const debouncedSearch = useDebounce(filter.searchText, 250);

  const filteredData = useMemo(() => {
    return data.filter(
      (row) =>
        matchesSearch(row, columns, debouncedSearch) &&
        matchesFilters(row, filter.activeFilters),
    );
  }, [data, columns, debouncedSearch, filter.activeFilters]);

  const sortedData = useMemo(() => {
    if (!sort.column) return filteredData;
    return [...filteredData].sort((a, b) => {
      const aVal = a[sort.column as keyof T];
      const bVal = b[sort.column as keyof T];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return sort.direction === 'asc' ? -1 : 1;
      if (bVal == null) return sort.direction === 'asc' ? 1 : -1;
      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      return sort.direction === 'asc' ? cmp : -cmp;
    });
  }, [filteredData, sort]);

  const totalPages = Math.max(1, Math.ceil(sortedData.length / pageSize));

  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [totalPages, page]);

  const pageData = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sortedData.slice(start, start + pageSize);
  }, [sortedData, page, pageSize]);

  const handleSort = useCallback((columnKey: string) => {
    setSort((prev) => {
      if (prev.column === columnKey) {
        return { column: columnKey, direction: prev.direction === 'asc' ? 'desc' : 'asc' };
      }
      return { column: columnKey, direction: 'asc' };
    });
  }, []);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setFilter((prev) => ({ ...prev, searchText: e.target.value }));
  }, []);

  const handleFilterToggle = useCallback((columnKey: string, value: string) => {
    setFilter((prev) => {
      const current = prev.activeFilters[columnKey] ?? [];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      return {
        ...prev,
        activeFilters: { ...prev.activeFilters, [columnKey]: next },
      };
    });
  }, []);

  const handleSelectAll = useCallback(() => {
`;

const anchorC_suffix_1 = `  }, [pageData]);

  const handleRowSelect = useCallback((id: string | number) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleClearFilters = useCallback(() => {
    setFilter({ searchText: '', activeFilters: {} });
    setSelectedRows(new Set());
  }, []);

  const filterOptions = useMemo(() => {
    const options: Record<string, string[]> = {};
    for (const col of filterableColumns) {
      options[col] = getUniqueValues(data, col);
    }
    return options;
  }, [data, filterableColumns]);

  if (loading) {
    return (
      <div className="data-table-loading" role="status">
        <div className="spinner" />
        <span>Loading...</span>
      </div>
    );
  }

  return (
    <div className="data-table-container">
      <div className="data-table-toolbar">
        <input
          type="text"
          className="data-table-search"
          placeholder="Search all columns..."
          value={filter.searchText}
          onChange={handleSearchChange}
        />
        {selectedRows.size > 0 && (
          <span className="selection-count">{selectedRows.size} selected</span>
        )}
      </div>
      <table className="data-table" role="grid">
        <thead className={stickyHeader ? 'sticky-header' : ''}>
          <tr>
            <th className="checkbox-cell">
              <input
                type="checkbox"
                checked={pageData.length > 0 && pageData.every((r) => selectedRows.has(r.id))}
                onChange={handleSelectAll}
              />
            </th>
            {columns.map((col) => (
              <th
                key={col.key}
                className={col.sortable ? 'sortable' : ''}
                onClick={col.sortable ? () => handleSort(col.key) : undefined}
              >
                {col.label}
                {sort.column === col.key && (
                  <span>{sort.direction === 'asc' ? ' \u2191' : ' \u2193'}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pageData.length === 0 ? (
            <tr>
              <td colSpan={columns.length + 1} className="empty-row">
                {emptyMessage}
              </td>
            </tr>
          ) : (
            pageData.map((row) => (
              <tr
                key={row.id}
                className={selectedRows.has(row.id) ? 'row-selected' : ''}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                <td className="checkbox-cell">
                  <input
                    type="checkbox"
                    checked={selectedRows.has(row.id)}
                    onChange={() => handleRowSelect(row.id)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </td>
                {columns.map((col) => (
                  <td key={col.key}>
                    {col.render ? col.render(row[col.key], row) : String(row[col.key] ?? '')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="data-table-pagination">
        <div className="pagination-info">
          Showing {Math.min((page - 1) * pageSize + 1, sortedData.length)}-{Math.min(page * pageSize, sortedData.length)} of {sortedData.length}
          {sortedData.length !== data.length && \` (filtered from \${data.length})\`}
        </div>
        <div className="pagination-controls">
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            aria-label="Rows per page"
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>{size} per page</option>
            ))}
          </select>
          <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Prev
          </button>
          <span>Page {page} of {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
`;

// ── Anchor D: Python async data pipeline ─────────────────────────────
//
// An async pipeline that reads from a queue, transforms through a processor
// chain, batches writes to PostgreSQL. ~9,000 chars total.

const anchorD_prefix = `"""
Async data pipeline for processing records from a message queue.

Reads messages, transforms through a processor chain, batches the results,
and writes them to PostgreSQL. Includes retry logic and dead-letter handling.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, AsyncIterator, Callable, Awaitable

import asyncpg

logger = logging.getLogger(__name__)


class RecordStatus(Enum):
    PENDING = "pending"
    PROCESSED = "processed"
    FAILED = "failed"
    DEAD_LETTER = "dead_letter"


@dataclass
class RawRecord:
    """A record as received from the message queue."""
    id: str
    payload: dict[str, Any]
    source_topic: str
    received_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    attempt: int = 0


@dataclass
class ProcessedRecord:
    """A record after transformation, ready for database insertion."""
    id: str
    original_id: str
    data: dict[str, Any]
    status: RecordStatus = RecordStatus.PROCESSED
    processed_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    processing_duration_ms: float = 0.0
    error_message: str | None = None


@dataclass
class PipelineStats:
    """Tracks pipeline throughput and error rates."""
    records_received: int = 0
    records_processed: int = 0
    records_failed: int = 0
    records_dead_lettered: int = 0
    batches_written: int = 0
    total_processing_ms: float = 0.0

    @property
    def success_rate(self) -> float:
        total = self.records_processed + self.records_failed
        return self.records_processed / total if total > 0 else 0.0

    @property
    def avg_processing_ms(self) -> float:
        if self.records_processed == 0:
            return 0.0
        return self.total_processing_ms / self.records_processed


@dataclass
class PipelineConfig:
    """Configuration for the data pipeline."""
    db_dsn: str
    source_queue_url: str
    batch_size: int = 100
    flush_interval_seconds: float = 5.0
    max_retries: int = 3
    retry_base_delay_seconds: float = 1.0
    max_concurrent_processors: int = 10
    table_name: str = "processed_records"


Processor = Callable[[RawRecord], Awaitable[dict[str, Any]]]


class ProcessorChain:
    """Ordered chain of async processors applied to each record."""

    def __init__(self) -> None:
        self._processors: list[tuple[str, Processor]] = []

    def add(self, name: str, processor: Processor) -> "ProcessorChain":
        self._processors.append((name, processor))
        return self

    async def execute(self, record: RawRecord) -> dict[str, Any]:
        result = dict(record.payload)
        for name, proc in self._processors:
            try:
                result = await proc(
                    RawRecord(
                        id=record.id,
                        payload=result,
                        source_topic=record.source_topic,
                        received_at=record.received_at,
                        attempt=record.attempt,
                    )
                )
            except Exception as exc:
                raise ProcessingError(
                    f"Processor '{name}' failed for record {record.id}: {exc}"
                ) from exc
        return result


class ProcessingError(Exception):
    pass


class BatchWriter:
    """Accumulates processed records and writes them in batches."""

    def __init__(self, config: PipelineConfig, pool: asyncpg.Pool) -> None:
        self._config = config
        self._pool = pool
        self._buffer: list[ProcessedRecord] = []
        self._lock = asyncio.Lock()
        self._last_flush = time.monotonic()

    async def add(self, record: ProcessedRecord) -> None:
        async with self._lock:
            self._buffer.append(record)

    async def should_flush(self) -> bool:
        elapsed = time.monotonic() - self._last_flush
        return (
            len(self._buffer) >= self._config.batch_size
            or elapsed >= self._config.flush_interval_seconds
        )

    async def flush(self) -> int:
        """Write buffered records to the database. Returns count written."""
        async with self._lock:
            if not self._buffer:
                return 0
            to_write = list(self._buffer)
            self._buffer.clear()

        table = self._config.table_name
        async with self._pool.acquire() as conn:
            async with conn.transaction():
`;

const anchorD_suffix_flush = `
        self._last_flush = time.monotonic()
        return len(to_write)


class Pipeline:
    """Orchestrates the full read-process-write pipeline."""

    def __init__(self, config: PipelineConfig, chain: ProcessorChain) -> None:
        self._config = config
        self._chain = chain
        self._pool: asyncpg.Pool | None = None
        self._writer: BatchWriter | None = None
        self._stats = PipelineStats()
        self._running = False
        self._semaphore: asyncio.Semaphore | None = None

    async def start(self) -> None:
        """Initialize the database pool and begin processing."""
        logger.info("Starting pipeline: %s", self._config.source_queue_url)
        self._pool = await asyncpg.create_pool(
            dsn=self._config.db_dsn,
            min_size=2,
            max_size=self._config.max_concurrent_processors,
        )
        self._writer = BatchWriter(self._config, self._pool)
        self._semaphore = asyncio.Semaphore(self._config.max_concurrent_processors)
        self._running = True

        flush_task = asyncio.create_task(self._flush_loop())
        try:
            await self._consume_loop()
        finally:
            self._running = False
            flush_task.cancel()
            if self._writer:
                remaining = await self._writer.flush()
                if remaining > 0:
                    self._stats.batches_written += 1
            if self._pool:
                await self._pool.close()
            logger.info("Pipeline stopped: %s", self._stats.__dict__)

    async def _consume_loop(self) -> None:
        async for batch in read_queue(self._config.source_queue_url):
            if not self._running:
                break
            self._stats.records_received += len(batch)
            tasks = [self._process_record(r) for r in batch]
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _flush_loop(self) -> None:
        while self._running:
            await asyncio.sleep(self._config.flush_interval_seconds)
            if self._writer and await self._writer.should_flush():
                count = await self._writer.flush()
                if count > 0:
                    self._stats.batches_written += 1

    async def _process_record(self, record: RawRecord) -> None:
        """Process a single record with retry logic."""
        assert self._semaphore is not None
        assert self._writer is not None

        async with self._semaphore:
            start_ms = time.monotonic() * 1000
            for attempt in range(1, self._config.max_retries + 1):
                record.attempt = attempt
                try:
                    transformed = await self._chain.execute(record)
                    duration_ms = time.monotonic() * 1000 - start_ms
                    processed = ProcessedRecord(
                        id=f"proc-{record.id}",
                        original_id=record.id,
                        data=transformed,
                        processing_duration_ms=duration_ms,
                    )
                    await self._writer.add(processed)
                    self._stats.records_processed += 1
                    self._stats.total_processing_ms += duration_ms
                    return
                except ProcessingError as exc:
                    delay = self._config.retry_base_delay_seconds * (2 ** (attempt - 1))
                    logger.warning(
                        "Record %s attempt %d/%d failed: %s",
                        record.id, attempt, self._config.max_retries, exc,
                    )
                    if attempt < self._config.max_retries:
                        await asyncio.sleep(delay)

            # Dead letter
            duration_ms = time.monotonic() * 1000 - start_ms
            failed = ProcessedRecord(
                id=f"proc-{record.id}",
                original_id=record.id,
                data=record.payload,
                status=RecordStatus.DEAD_LETTER,
                processing_duration_ms=duration_ms,
                error_message=f"Failed after {self._config.max_retries} attempts",
            )
            await self._writer.add(failed)
            self._stats.records_failed += 1
            self._stats.records_dead_lettered += 1


async def read_queue(
    queue_url: str, poll_interval: float = 0.5, max_batch: int = 50,
) -> AsyncIterator[list[RawRecord]]:
    """Read batches from a message queue (simulated)."""
    counter = 0
    while True:
        await asyncio.sleep(poll_interval)
        size = min(max_batch, 10 + counter % 40)
        batch: list[RawRecord] = []
        for _ in range(size):
            counter += 1
            batch.append(RawRecord(
                id=f"msg-{counter:08d}",
                payload={"event_type": "user_action", "user_id": f"usr-{counter % 1000:04d}"},
                source_topic="events.user_actions",
            ))
        yield batch
`;

// Scenario 3: cursor inside _consume_loop, right after updating
// records_received and before dispatching tasks for processing.

const anchorD_split2_marker = `            tasks = [self._process_record(r) for r in batch]`;

const anchorD_split2_idx = anchorD_suffix_flush.indexOf(anchorD_split2_marker);

const anchorD_prefix_2 = anchorD_prefix + anchorD_suffix_flush.slice(0, anchorD_split2_idx);
const anchorD_suffix_2 = anchorD_suffix_flush.slice(anchorD_split2_idx);

// ── Scenarios ────────────────────────────────────────────────────────

export const codeFullWindowScenarios: TestScenario[] = [
  {
    id: 'code-full-react-select-all',
    description: 'React data table component, cursor inside handleSelectAll callback body',
    mode: 'code' as const,
    languageId: 'typescriptreact',
    fileName: 'DataTable.tsx',
    prefix: anchorC_prefix_1,
    suffix: anchorC_suffix_1,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['\`\`\`', 'import'],
      quality_notes:
        'Cursor is inside the handleSelectAll callback body. The function should toggle selection of all rows currently visible on the page (pageData). If all page rows are already selected, deselect them; otherwise select all. Must use setSelectedRows with a Set and reference pageData and row.id. Should follow the same functional-update pattern as handleRowSelect above it. Valid TypeScript/TSX.',
    },
  },

  {
    id: 'code-full-py-pipeline-flush',
    description: 'Python async pipeline, cursor inside BatchWriter.flush() transaction block',
    mode: 'code' as const,
    languageId: 'python',
    fileName: 'pipeline.py',
    prefix: anchorD_prefix,
    suffix: anchorD_suffix_flush,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['\`\`\`', 'import', 'class BatchWriter'],
      quality_notes:
        'Cursor is inside the flush() method, within an async transaction block (async with conn.transaction()). Should write the to_write list of ProcessedRecord objects to the database using executemany or a batched INSERT. Must reference the table variable, conn, and ProcessedRecord fields (id, original_id, data, status, processed_at, processing_duration_ms, error_message). Should use asyncpg parameterized queries ($1, $2, ...). The suffix expects this block to complete so self._last_flush is updated next. Python indentation: 16 spaces inside the transaction block.',
    },
  },

  {
    id: 'code-full-py-pipeline-dispatch',
    description: 'Python async pipeline, cursor inside _consume_loop before task dispatch',
    mode: 'code' as const,
    languageId: 'python',
    fileName: 'pipeline.py',
    prefix: anchorD_prefix_2,
    suffix: anchorD_suffix_2,
    saturation: { prefix: 'saturated', suffix: 'saturated' },
    requirements: {
      must_not_include: ['\`\`\`', 'import', 'class Pipeline'],
      quality_notes:
        'Cursor is inside _consume_loop, after incrementing records_received by the batch length, and before dispatching processing tasks. The suffix starts with "            tasks = [self._process_record(r) for r in batch]" followed by asyncio.gather. The completion should lead naturally into the task creation line or produce equivalent dispatch logic. Must use self._process_record and asyncio patterns consistent with the surrounding code. Python indentation: 12 spaces (inside the async for loop body).',
    },
  },
] as const satisfies readonly TestScenario[];
