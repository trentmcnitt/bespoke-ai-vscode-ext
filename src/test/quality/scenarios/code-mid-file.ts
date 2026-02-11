/**
 * Mid-file code scenarios for quality evaluation.
 *
 * Each scenario represents a realistic code file with 8000+ characters of
 * context. Prefix and suffix simulate truncated views of larger files, with
 * the cursor placed at a natural editing point inside the file.
 */
import { TestScenario } from '../judge';

export const codeMidFileScenarios: TestScenario[] = [
  // ── TypeScript: Express route handlers ──────────────────────────────

  {
    id: 'code-mid-file-ts-handler-full',
    description: 'Express handler file, cursor in new route handler body',
    mode: 'code' as const,
    languageId: 'typescript',
    fileName: 'routes.ts',
    prefix: `      if (roleFilter) {
        query = query.where('role', roleFilter);
      }

      const [users, countResult] = await Promise.all([
        query.clone().offset(offset).limit(limit).orderBy('created_at', 'desc'),
        query.clone().count('* as total').first(),
      ]);

      const total = Number(countResult?.total ?? 0);

      res.json(paginatedResponse(users, page, limit, total));
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /users/:id
 * Retrieve a single user by ID, with recent activity summary.
 */
router.get(
  '/users/:id',
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Check cache first
      const cached = await redis.get(\`user:\${req.params.id}:profile\`);
      if (cached) {
        res.json(JSON.parse(cached));
        return;
      }

      const user = await db('users')
        .select(
          'id', 'email', 'display_name', 'role',
          'avatar_url', 'bio', 'created_at', 'updated_at', 'last_login_at',
        )
        .where('id', req.params.id)
        .whereNull('deleted_at')
        .first();

      if (!user) {
        throw new NotFoundError(\`User \${req.params.id} not found\`);
      }

      // Attach recent activity counts
      const [activityCount, projectCount] = await Promise.all([
        db('activity_log')
          .where('user_id', req.params.id)
          .where('created_at', '>', db.raw("now() - interval '30 days'"))
          .count('* as total')
          .first(),
        db('project_members')
          .where('user_id', req.params.id)
          .count('* as total')
          .first(),
      ]);

      const profile = {
        ...user,
        recentActivityCount: Number(activityCount?.total ?? 0),
        projectCount: Number(projectCount?.total ?? 0),
      };

      // Cache for 5 minutes
      await redis.setex(\`user:\${req.params.id}:profile\`, 300, JSON.stringify(profile));

      res.json(profile);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /users
 * Create a new user account. Sends a welcome email on success.
 */
router.post(
  '/users',
  authenticateToken,
  requireRole('admin'),
  validateBody(schemas.createUser),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, displayName, role, password } = req.body;

      // Check for existing user with same email
      const existing = await db('users').where('email', email.toLowerCase()).first();
      if (existing) {
        throw new ConflictError(\`User with email \${email} already exists\`);
      }

      const passwordHash = await hashPassword(password);

      const [newUser] = await db('users')
        .insert({
          email: email.toLowerCase(),
          display_name: displayName,
          password_hash: passwordHash,
          role: role || 'member',
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returning(['id', 'email', 'display_name', 'role', 'created_at']);

      logger.info({ userId: newUser.id, email }, 'User created');

      // Send welcome email asynchronously — don't block the response
      sendEmail({
        to: email,
        template: 'welcome',
        data: { displayName, loginUrl: \`\${process.env.APP_URL}/login\` },
      }).catch(err => logger.error({ err, email }, 'Failed to send welcome email'));

      res.status(201).json(newUser);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * PUT /users/:id
 * Update an existing user's profile fields.
 */
router.put(
  '/users/:id',
  authenticateToken,
  validateBody(schemas.updateUser),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { displayName, role, avatarUrl, bio } = req.body;

`,
    suffix: `
      await invalidateUserCache(req.params.id);
      logger.info({ userId: req.params.id, changes: req.body }, 'User updated');

      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /users/:id
 * Soft-delete a user account and revoke all sessions.
 */
router.delete(
  '/users/:id',
  authenticateToken,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await db('users')
        .where('id', req.params.id)
        .whereNull('deleted_at')
        .first();

      if (!user) {
        throw new NotFoundError(\`User \${req.params.id} not found\`);
      }

      // Prevent self-deletion
      const requestingUser = (req as any).user;
      if (requestingUser.id === req.params.id) {
        throw new ForbiddenError('Cannot delete your own account');
      }

      // Soft-delete: mark as deleted rather than removing the row
      await db('users').where('id', req.params.id).update({
        deleted_at: new Date(),
        updated_at: new Date(),
        email: db.raw("email || '_deleted_' || id"),
      });

      // Revoke all active sessions
      await db('sessions')
        .where('user_id', req.params.id)
        .where('expires_at', '>', new Date())
        .update({ revoked: true });

      await invalidateUserCache(req.params.id);
      logger.info({ userId: req.params.id, deletedBy: requestingUser.id }, 'User soft-deleted');

      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

// ── Invite routes ─────────────────────────────────────────────────

/**
 * POST /users/invite
 * Generate an invite link and send it via email.
 */
router.post(
  '/users/invite',
  authenticateToken,
  requireRole('admin'),
  validateBody(schemas.inviteUser),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, role } = req.body;
      const invitedBy = (req as any).user.id;

      // Check if user already exists
      const existing = await db('users').where('email', email.toLowerCase()).first();
      if (existing) {
        throw new ConflictError(\`User with email \${email} already exists\`);
      }

      const token = generateInviteToken();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      await db('invitations').insert({
        email: email.toLowerCase(),
        token,
        role: role || 'member',
        invited_by: invitedBy,
        expires_at: expiresAt,
        created_at: new Date(),
      });

      await sendEmail({
        to: email,
        template: 'invite',
        data: {
          inviteUrl: \`\${process.env.APP_URL}/accept-invite?token=\${token}\`,
          expiresAt: expiresAt.toISOString(),
        },
      });

      logger.info({ email, invitedBy }, 'Invitation sent');

      res.status(201).json({ email, expiresAt });
    } catch (err) {
      next(err);
    }
  },
);

// ── Team routes ───────────────────────────────────────────────────

/**
 * GET /teams
 * List all teams the authenticated user belongs to.
 */
router.get(
  '/teams',
  authenticateToken,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).user.id;

      const teams = await db('teams')
        .join('team_members', 'teams.id', 'team_members.team_id')
        .where('team_members.user_id', userId)
        .select(
          'teams.id',
          'teams.name',
          'teams.description',
          'team_members.role as memberRole',
          'teams.created_at',
        )
        .orderBy('teams.name');

      res.json({ data: teams });
    } catch (err) {
      next(err);
    }
  },
);

export default router;`,
    requirements: {
      must_not_include: ['```', 'import'],
      quality_notes:
        'Cursor is inside the PUT /users/:id handler body, after destructuring the request body. Should build an update object from the destructured fields, run a db update query on the users table, and assign the result to an "updated" variable (referenced in the suffix). Must handle the not-found case and use valid TypeScript.',
    },
    saturation: { prefix: 'saturated', suffix: 'saturated' },
  },

  // ── TypeScript: Event store class ───────────────────────────────────

  {
    id: 'code-mid-file-ts-class-full',
    description: 'TypeScript class with multiple methods, cursor between methods',
    mode: 'code' as const,
    languageId: 'typescript',
    fileName: 'event-store.ts',
    prefix: `class EventStore {
  private readonly pool: Pool;
  private readonly streamPrefix: string;

  constructor(config: EventStoreConfig) {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      max: config.poolSize ?? 10,
    });
    this.streamPrefix = config.streamPrefix ?? '';
  }

  /**
   * Append one or more events to a stream. If expectedVersion is provided,
   * the append will fail with a ConcurrencyError if the current stream
   * version does not match.
   */
  async append(
    streamId: string,
    events: NewEvent[],
    expectedVersion?: number,
  ): Promise<AppendResult> {
    const qualifiedStream = this.streamPrefix + streamId;
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const currentVersion = await this.resolveStreamVersion(client, qualifiedStream);

      if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
        await client.query('ROLLBACK');
        throw new ConcurrencyError(
          qualifiedStream,
          expectedVersion,
          currentVersion,
        );
      }

      const appendedEvents: StoredEvent[] = [];

      for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const newVersion = currentVersion + i + 1;

        const insertResult = await client.query<{ global_position: string }>(
          \`INSERT INTO events (stream_id, version, event_type, payload, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, now())
           RETURNING global_position\`,
          [
            qualifiedStream,
            newVersion,
            event.type,
            JSON.stringify(event.payload),
            JSON.stringify(event.metadata ?? {}),
          ],
        );

        appendedEvents.push({
          globalPosition: BigInt(insertResult.rows[0].global_position),
          streamId: qualifiedStream,
          version: newVersion,
          type: event.type,
          payload: event.payload,
          metadata: event.metadata ?? {},
          createdAt: new Date(),
        });
      }

      // Update stream version
      const finalVersion = currentVersion + events.length;
      await client.query(
        'UPDATE streams SET version = $1, updated_at = now() WHERE stream_id = $2',
        [finalVersion, qualifiedStream],
      );

      await client.query('COMMIT');

      return {
        streamId: qualifiedStream,
        fromVersion: currentVersion + 1,
        toVersion: finalVersion,
        events: appendedEvents,
      };
    } catch (err) {
      if (!(err instanceof ConcurrencyError)) {
        await client.query('ROLLBACK');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Read events from a specific stream, optionally starting from a given
   * version. Returns events in version order.
   */
  async readStream(
    streamId: string,
    options: ReadOptions = {},
  ): Promise<StoredEvent[]> {
    const qualifiedStream = this.streamPrefix + streamId;
    const fromVersion = options.fromVersion ?? 0;
    const maxCount = options.maxCount ?? 1000;

    const result = await this.pool.query<EventRow>(
      \`SELECT global_position, stream_id, version, event_type, payload,
              metadata, created_at
       FROM events
       WHERE stream_id = $1 AND version > $2
       ORDER BY version ASC
       LIMIT $3\`,
      [qualifiedStream, fromVersion, maxCount],
    );

    return result.rows.map(this.mapRowToEvent);
  }

`,
    suffix: `
  /**
   * Subscribe to new events across all streams starting from a global
   * position. Uses polling with configurable interval.
   */
  subscribe(
    fromPosition: bigint,
    handler: (event: StoredEvent) => Promise<void>,
    options: SubscribeOptions = {},
  ): Subscription {
    const pollInterval = options.pollIntervalMs ?? 500;
    const batchSize = options.batchSize ?? 100;
    let currentPosition = fromPosition;
    let running = true;

    const poll = async (): Promise<void> => {
      while (running) {
        try {
          const events = await this.readAll({
            fromPosition: currentPosition,
            maxCount: batchSize,
          });

          for (const event of events) {
            if (!running) break;
            await handler(event);
            currentPosition = event.globalPosition + 1n;
          }

          if (events.length < batchSize) {
            // No more events — wait before polling again
            await new Promise(resolve => setTimeout(resolve, pollInterval));
          }
        } catch (err) {
          // Log and continue polling — transient errors should not kill the subscription
          console.error('Subscription poll error:', err);
          await new Promise(resolve => setTimeout(resolve, pollInterval * 2));
        }
      }
    };

    const pollPromise = poll();

    return {
      stop: async () => {
        running = false;
        await pollPromise;
      },
      position: () => currentPosition,
    };
  }

  /**
   * Get the current version of a stream (the version of the latest event).
   * Returns -1 if the stream does not exist.
   */
  async getStreamVersion(streamId: string): Promise<number> {
    const qualifiedStream = this.streamPrefix + streamId;
    const result = await this.pool.query<{ version: number }>(
      'SELECT version FROM streams WHERE stream_id = $1',
      [qualifiedStream],
    );
    return result.rows.length > 0 ? result.rows[0].version : -1;
  }

  /**
   * Delete all events and the stream record for a given stream.
   * Intended for testing — do not use in production.
   */
  async deleteStream(streamId: string): Promise<void> {
    const qualifiedStream = this.streamPrefix + streamId;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM events WHERE stream_id = $1', [qualifiedStream]);
      await client.query('DELETE FROM streams WHERE stream_id = $1', [qualifiedStream]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private mapRowToEvent(row: EventRow): StoredEvent {
    return {
      globalPosition: BigInt(row.global_position),
      streamId: row.stream_id,
      version: row.version,
      type: row.event_type,
      payload: JSON.parse(row.payload),
      metadata: JSON.parse(row.metadata),
      createdAt: row.created_at,
    };
  }

  /**
   * List all streams with their current version and event count.
   */
  async listStreams(): Promise<Array<{ streamId: string; version: number; eventCount: number }>> {
    const result = await this.pool.query<{
      stream_id: string;
      version: number;
      event_count: string;
    }>(
      \`SELECT s.stream_id, s.version,
              (SELECT count(*) FROM events e WHERE e.stream_id = s.stream_id) AS event_count
       FROM streams s
       ORDER BY s.stream_id\`,
    );
    return result.rows.map(r => ({
      streamId: r.stream_id,
      version: r.version,
      eventCount: Number(r.event_count),
    }));
  }

  async dispose(): Promise<void> {
    await this.pool.end();`,
    requirements: {
      must_not_include: ['```', 'import', 'class '],
      quality_notes:
        'Cursor is between the readStream method and the subscribe method — a natural place to add the readAll method, which reads events across all streams from a global position. The suffix references this.readAll(), so the completion should define that method with a fromPosition and maxCount option, querying by global_position. Should follow the same patterns as readStream: query, map rows, return StoredEvent[]. Valid TypeScript with proper async/Promise usage.',
    },
    saturation: { prefix: 'saturated', suffix: 'saturated' },
  },

  // ── Python: Analytics module ────────────────────────────────────────

  {
    id: 'code-mid-file-py-module-full',
    description: 'Python analytics module, cursor in a method body',
    mode: 'code' as const,
    languageId: 'python',
    fileName: 'analytics.py',
    prefix: `from __future__ import annotations

__all__ = [
    "MetricCollector",
    "TimeWindow",
    "AggregationResult",
    "compute_percentile",
]


class TimeWindow(Enum):
    """Supported aggregation windows."""

    MINUTE = "1m"
    FIVE_MINUTES = "5m"
    HOUR = "1h"
    DAY = "1d"
    WEEK = "7d"

    @property
    def seconds(self) -> int:
        mapping = {
            "1m": 60,
            "5m": 300,
            "1h": 3600,
            "1d": 86400,
            "7d": 604800,
        }
        return mapping[self.value]


@dataclass(frozen=True)
class AggregationResult:
    """Immutable result of an aggregation computation."""

    window: TimeWindow
    metric_name: str
    count: int
    total: float
    mean: float
    min_val: float
    max_val: float
    p50: float
    p95: float
    p99: float
    start_time: datetime
    end_time: datetime

    @property
    def duration_seconds(self) -> float:
        return (self.end_time - self.start_time).total_seconds()

    def to_dict(self) -> dict[str, Any]:
        return {
            "window": self.window.value,
            "metric": self.metric_name,
            "count": self.count,
            "total": round(self.total, 4),
            "mean": round(self.mean, 4),
            "min": round(self.min_val, 4),
            "max": round(self.max_val, 4),
            "p50": round(self.p50, 4),
            "p95": round(self.p95, 4),
            "p99": round(self.p99, 4),
            "start": self.start_time.isoformat(),
            "end": self.end_time.isoformat(),
        }


def compute_percentile(sorted_values: list[float], percentile: float) -> float:
    """Compute a percentile from a pre-sorted list of values.

    Uses linear interpolation between closest ranks.
    """
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return sorted_values[0]

    rank = (percentile / 100.0) * (len(sorted_values) - 1)
    lower = int(rank)
    upper = lower + 1
    weight = rank - lower

    if upper >= len(sorted_values):
        return sorted_values[-1]

    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight


class MetricCollector:
    """Collects timestamped metric samples and computes windowed aggregations.

    Thread-safe for concurrent record() calls. Samples older than the
    retention period are pruned automatically on each aggregation call.
    """

    def __init__(
        self,
        name: str,
        retention: timedelta = timedelta(hours=24),
        max_samples: int = 100_000,
    ) -> None:
        self._name = name
        self._retention = retention
        self._max_samples = max_samples
        self._lock = threading.Lock()
        self._samples: list[tuple[datetime, float]] = []
        self._total_recorded: int = 0

    @property
    def name(self) -> str:
        return self._name

    @property
    def total_recorded(self) -> int:
        return self._total_recorded

    def record(self, value: float, timestamp: datetime | None = None) -> None:
        """Record a single metric sample."""
        ts = timestamp or datetime.now(timezone.utc)
        with self._lock:
            self._samples.append((ts, value))
            self._total_recorded += 1
            # Enforce max sample limit by dropping oldest entries
            if len(self._samples) > self._max_samples:
                self._samples = self._samples[-self._max_samples :]

    def aggregate(self, window: TimeWindow) -> AggregationResult | None:
        """Compute aggregation for the most recent window.

        Returns None if there are no samples in the window.
        """
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(seconds=window.seconds)

`,
    suffix: `
        if not values:
            return None

        sorted_vals = sorted(values)
        total = sum(sorted_vals)
        count = len(sorted_vals)

        return AggregationResult(
            window=window,
            metric_name=self._name,
            count=count,
            total=total,
            mean=total / count,
            min_val=sorted_vals[0],
            max_val=sorted_vals[-1],
            p50=compute_percentile(sorted_vals, 50),
            p95=compute_percentile(sorted_vals, 95),
            p99=compute_percentile(sorted_vals, 99),
            start_time=cutoff,
            end_time=now,
        )

    def aggregate_all_windows(self) -> dict[TimeWindow, AggregationResult | None]:
        """Run aggregation for every defined time window."""
        return {w: self.aggregate(w) for w in TimeWindow}

    def _prune_expired(self) -> None:
        """Remove samples outside the retention period."""
        cutoff = datetime.now(timezone.utc) - self._retention
        with self._lock:
            self._samples = [
                (ts, val) for ts, val in self._samples if ts >= cutoff
            ]

    def reset(self) -> None:
        """Clear all recorded samples."""
        with self._lock:
            self._samples.clear()
            self._total_recorded = 0

    def snapshot(self) -> list[tuple[datetime, float]]:
        """Return a copy of the current sample buffer."""
        with self._lock:
            return list(self._samples)


class DashboardBuilder:
    """Builds summary dashboards from multiple MetricCollectors."""

    def __init__(self) -> None:
        self._collectors: dict[str, MetricCollector] = {}

    def register(self, collector: MetricCollector) -> None:
        self._collectors[collector.name] = collector

    def unregister(self, name: str) -> None:
        self._collectors.pop(name, None)

    def build_summary(
        self, window: TimeWindow
    ) -> dict[str, dict[str, Any]]:
        """Build a summary for all registered collectors."""
        summary: dict[str, dict[str, Any]] = {}
        for name, collector in self._collectors.items():
            result = collector.aggregate(window)
            if result is not None:
                summary[name] = result.to_dict()
            else:
                summary[name] = {"status": "no_data"}
        return summary

    def build_report(self) -> dict[str, Any]:
        """Build a full report across all windows and collectors."""
        report: dict[str, Any] = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "collectors": {},
        }
        for name, collector in self._collectors.items():
            report["collectors"][name] = {
                "total_recorded": collector.total_recorded,
                "sample_count": len(collector.snapshot()),
                "windows": {},
            }
            for w in TimeWindow:
                result = collector.aggregate(w)
                report["collectors"][name]["windows"][w.value] = (
                    result.to_dict() if result else None
                )
        return report

    def get_status(self) -> dict[str, str]:
        """Quick health check — reports which collectors have recent data."""
        status: dict[str, str] = {}
        for name, collector in self._collectors.items():
            result = collector.aggregate(TimeWindow.FIVE_MINUTES)
            if result is not None and result.count > 0:
                status[name] = "active"
            else:
                status[name] = "stale"
        return status`,
    requirements: {
      must_not_include: ['```', 'import', 'class MetricCollector'],
      quality_notes:
        'Cursor is inside the aggregate() method body, right after computing the cutoff time. The method needs to prune old samples, filter to the window, and extract the values list. The suffix expects a local variable "values" (list[float]) to already be populated. Should acquire the lock, prune expired samples, filter self._samples to entries with ts >= cutoff, and build values = [val for ts, val in ...]. Must use correct Python indentation (8 spaces for method body).',
    },
    saturation: { prefix: 'saturated', suffix: 'saturated' },
  },

  // ── Python: Flask API routes ────────────────────────────────────────

  {
    id: 'code-mid-file-py-flask-full',
    description: 'Flask route handlers, cursor in a POST handler body',
    mode: 'code' as const,
    languageId: 'python',
    fileName: 'api.py',
    prefix: `task_create_schema = TaskCreateSchema()
task_update_schema = TaskUpdateSchema()
comment_schema = CommentSchema()


def require_project_access(f):
    """Decorator that loads the project and checks user membership."""
    @wraps(f)
    def decorated(*args, **kwargs):
        project_id = kwargs.get("project_id")
        project = Project.query.get_or_404(project_id)
        user = get_current_user()
        if user not in project.members and user != project.owner:
            abort(403, description="Not a member of this project")
        g.project = project
        return f(*args, **kwargs)
    return decorated


# ── Project routes ─────────────────────────────────────────────────


@api.route("/projects", methods=["GET"])
@require_auth
def list_projects():
    """List all projects the current user has access to."""
    user = get_current_user()
    owned = Project.query.filter_by(owner_id=user.id).all()
    member_of = (
        Project.query.join(Project.members)
        .filter_by(id=user.id)
        .all()
    )
    all_projects = {p.id: p for p in owned + member_of}
    return jsonify([project_schema.dump(p) for p in all_projects.values()])


@api.route("/projects", methods=["POST"])
@require_auth
def create_project():
    """Create a new project."""
    try:
        data = project_schema.load(request.get_json())
    except ValidationError as err:
        return jsonify({"errors": err.messages}), 400

    user = get_current_user()
    project = Project(
        name=data["name"],
        description=data.get("description", ""),
        owner_id=user.id,
        created_at=datetime.now(timezone.utc),
    )
    db.session.add(project)
    db.session.commit()
    return jsonify(project_schema.dump(project)), 201


# ── Task routes ────────────────────────────────────────────────────


@api.route("/projects/<int:project_id>/tasks", methods=["GET"])
@require_auth
@require_project_access
def list_tasks(project_id: int):
    """List tasks in a project with optional status filter."""
    status_filter = request.args.get("status")
    query = Task.query.filter_by(project_id=project_id)

    if status_filter:
        try:
            status = TaskStatus(status_filter)
            query = query.filter_by(status=status)
        except ValueError:
            return jsonify({"error": f"Invalid status: {status_filter}"}), 400

    sort_by = request.args.get("sort", "created_at")
    sort_order = request.args.get("order", "desc")

    if sort_by not in ("created_at", "priority", "due_date", "title"):
        sort_by = "created_at"

    column = getattr(Task, sort_by)
    if sort_order == "asc":
        query = query.order_by(column.asc())
    else:
        query = query.order_by(column.desc())

    page = request.args.get("page", 1, type=int)
    per_page = min(request.args.get("per_page", 20, type=int), 100)
    pagination = query.paginate(page=page, per_page=per_page, error_out=False)

    return jsonify({
        "tasks": task_create_schema.dump(pagination.items, many=True),
        "total": pagination.total,
        "page": page,
        "per_page": per_page,
        "pages": pagination.pages,
    })


@api.route("/projects/<int:project_id>/tasks", methods=["POST"])
@require_auth
@require_project_access
def create_task(project_id: int):
    """Create a new task in a project."""
    try:
        data = task_create_schema.load(request.get_json())
    except ValidationError as err:
        return jsonify({"errors": err.messages}), 400

    user = get_current_user()

`,
    suffix: `
    db.session.add(task)

    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return jsonify({"error": "Duplicate task title in this project"}), 409

    return jsonify(task_create_schema.dump(task)), 201


@api.route("/projects/<int:project_id>/tasks/<int:task_id>", methods=["PUT"])
@require_auth
@require_project_access
def update_task(project_id: int, task_id: int):
    """Update an existing task."""
    task = Task.query.filter_by(id=task_id, project_id=project_id).first_or_404()

    try:
        data = task_update_schema.load(request.get_json())
    except ValidationError as err:
        return jsonify({"errors": err.messages}), 400

    for field in ("title", "description", "status", "priority", "due_date", "assignee_id"):
        if field in data:
            setattr(task, field, data[field])

    task.updated_at = datetime.now(timezone.utc)
    db.session.commit()
    return jsonify(task_update_schema.dump(task))


@api.route("/projects/<int:project_id>/tasks/<int:task_id>", methods=["DELETE"])
@require_auth
@require_project_access
def delete_task(project_id: int, task_id: int):
    """Delete a task and its comments."""
    task = Task.query.filter_by(id=task_id, project_id=project_id).first_or_404()
    Comment.query.filter_by(task_id=task.id).delete()
    db.session.delete(task)
    db.session.commit()
    return "", 204


# ── Comment routes ─────────────────────────────────────────────────


@api.route("/projects/<int:project_id>/tasks/<int:task_id>/comments", methods=["GET"])
@require_auth
@require_project_access
def list_comments(project_id: int, task_id: int):
    """List comments on a task."""
    task = Task.query.filter_by(id=task_id, project_id=project_id).first_or_404()
    comments = (
        Comment.query.filter_by(task_id=task.id)
        .order_by(Comment.created_at.asc())
        .all()
    )
    return jsonify([comment_schema.dump(c) for c in comments])


@api.route("/projects/<int:project_id>/tasks/<int:task_id>/comments", methods=["POST"])
@require_auth
@require_project_access
def create_comment(project_id: int, task_id: int):
    """Add a comment to a task."""
    task = Task.query.filter_by(id=task_id, project_id=project_id).first_or_404()

    try:
        data = comment_schema.load(request.get_json())
    except ValidationError as err:
        return jsonify({"errors": err.messages}), 400

    user = get_current_user()
    comment = Comment(
        task_id=task.id,
        author_id=user.id,
        body=data["body"],
        created_at=datetime.now(timezone.utc),
    )
    db.session.add(comment)
    db.session.commit()
    return jsonify(comment_schema.dump(comment)), 201


@api.route("/projects/<int:project_id>/search", methods=["GET"])
@require_auth
@require_project_access
def search_project(project_id: int):
    """Full-text search across tasks and comments in a project."""
    query_str = request.args.get("q", "").strip()
    if not query_str or len(query_str) < 2:
        return jsonify({"error": "Search query must be at least 2 characters"}), 400

    tasks = (
        Task.query.filter_by(project_id=project_id)
        .filter(
            db.or_(
                Task.title.ilike(f"%{query_str}%"),
                Task.description.ilike(f"%{query_str}%"),
            )
        )
        .limit(20)
        .all()
    )

    return jsonify({
        "tasks": task_create_schema.dump(tasks, many=True),
    })`,
    requirements: {
      must_not_include: ['```', 'from flask', 'from .models'],
      quality_notes:
        'Cursor is inside create_task() after validating input and getting the user. Should construct a Task model instance from the validated data (title, description, status, priority, due_date, assignee_id) with project_id and created_by set from context. The suffix expects a "task" variable to be assigned. Must use correct Python indentation (4 spaces for function body).',
    },
    saturation: { prefix: 'saturated', suffix: 'saturated' },
  },

  // ── Go: Service with structs, methods, interfaces ───────────────────

  {
    id: 'code-mid-file-go-full',
    description: 'Go service package, cursor in a method body',
    mode: 'code' as const,
    languageId: 'go',
    fileName: 'service.go',
    prefix: `	"sync"
	"time"
)

// ErrNotFound indicates the requested resource does not exist.
var ErrNotFound = errors.New("not found")

// ErrConflict indicates a conflicting operation (e.g., duplicate key).
var ErrConflict = errors.New("conflict")

// Repository defines the persistence interface for orders.
type Repository interface {
	GetByID(ctx context.Context, id string) (*Order, error)
	List(ctx context.Context, filter OrderFilter) ([]Order, error)
	Create(ctx context.Context, order *Order) error
	Update(ctx context.Context, order *Order) error
	Delete(ctx context.Context, id string) error
}

// Notifier sends notifications about order state changes.
type Notifier interface {
	SendOrderConfirmation(ctx context.Context, order *Order) error
	SendShipmentUpdate(ctx context.Context, order *Order, tracking string) error
	SendDeliveryConfirmation(ctx context.Context, order *Order) error
}

// OrderStatus represents the lifecycle state of an order.
type OrderStatus string

const (
	StatusPending    OrderStatus = "pending"
	StatusConfirmed  OrderStatus = "confirmed"
	StatusShipped    OrderStatus = "shipped"
	StatusDelivered  OrderStatus = "delivered"
	StatusCancelled  OrderStatus = "cancelled"
)

// Order represents a customer order in the system.
type Order struct {
	ID             string      \`json:"id"\`
	CustomerID     string      \`json:"customer_id"\`
	Status         OrderStatus \`json:"status"\`
	Items          []OrderItem \`json:"items"\`
	ShippingAddr   Address     \`json:"shipping_address"\`
	TotalCents     int64       \`json:"total_cents"\`
	TrackingNumber string      \`json:"tracking_number,omitempty"\`
	Notes          string      \`json:"notes,omitempty"\`
	CreatedAt      time.Time   \`json:"created_at"\`
	UpdatedAt      time.Time   \`json:"updated_at"\`
}

// OrderItem is a single line item within an order.
type OrderItem struct {
	ProductID   string \`json:"product_id"\`
	ProductName string \`json:"product_name"\`
	Quantity    int    \`json:"quantity"\`
	UnitCents   int64  \`json:"unit_cents"\`
}

// Address holds a shipping or billing address.
type Address struct {
	Street  string \`json:"street"\`
	City    string \`json:"city"\`
	State   string \`json:"state"\`
	ZipCode string \`json:"zip_code"\`
	Country string \`json:"country"\`
}

// OrderFilter controls what orders are returned by List.
type OrderFilter struct {
	CustomerID string
	Status     OrderStatus
	Since      time.Time
	Limit      int
}

// Service implements the business logic for order management.
type Service struct {
	repo     Repository
	notifier Notifier
	mu       sync.Mutex
	logger   *log.Logger
}

// NewService creates a new order management service.
func NewService(repo Repository, notifier Notifier, logger *log.Logger) *Service {
	return &Service{
		repo:     repo,
		notifier: notifier,
		logger:   logger,
	}
}

// GetOrder retrieves an order by its ID.
func (s *Service) GetOrder(ctx context.Context, id string) (*Order, error) {
	order, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("get order %s: %w", id, err)
	}
	return order, nil
}

// ListOrders returns orders matching the given filter.
func (s *Service) ListOrders(ctx context.Context, filter OrderFilter) ([]Order, error) {
	if filter.Limit <= 0 || filter.Limit > 500 {
		filter.Limit = 100
	}
	orders, err := s.repo.List(ctx, filter)
	if err != nil {
		return nil, fmt.Errorf("list orders: %w", err)
	}
	return orders, nil
}

// CreateOrder validates and persists a new order.
func (s *Service) CreateOrder(ctx context.Context, order *Order) error {
	if err := s.validateOrder(order); err != nil {
		return fmt.Errorf("validate order: %w", err)
	}

	order.ID = generateID()
	order.Status = StatusPending
	order.CreatedAt = time.Now().UTC()
	order.UpdatedAt = order.CreatedAt
	order.TotalCents = s.calculateTotal(order.Items)

`,
    suffix: `
	s.logger.Printf("order created: id=%s customer=%s total=%d", order.ID, order.CustomerID, order.TotalCents)

	// Send confirmation asynchronously — don't block the create response
	go func() {
		notifyCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.notifier.SendOrderConfirmation(notifyCtx, order); err != nil {
			s.logger.Printf("failed to send order confirmation for %s: %v", order.ID, err)
		}
	}()

	return nil
}

// ShipOrder transitions an order to shipped status and records the tracking number.
func (s *Service) ShipOrder(ctx context.Context, id string, trackingNumber string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	order, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return fmt.Errorf("get order for shipment %s: %w", id, err)
	}

	if order.Status != StatusConfirmed {
		return fmt.Errorf("cannot ship order in status %s: expected confirmed", order.Status)
	}

	order.Status = StatusShipped
	order.TrackingNumber = trackingNumber
	order.UpdatedAt = time.Now().UTC()

	if err := s.repo.Update(ctx, order); err != nil {
		return fmt.Errorf("update order %s for shipment: %w", id, err)
	}

	s.logger.Printf("order shipped: id=%s tracking=%s", id, trackingNumber)

	go func() {
		notifyCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := s.notifier.SendShipmentUpdate(notifyCtx, order, trackingNumber); err != nil {
			s.logger.Printf("failed to send shipment notification for %s: %v", id, err)
		}
	}()

	return nil
}

// CancelOrder cancels a pending or confirmed order.
func (s *Service) CancelOrder(ctx context.Context, id string, reason string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	order, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return fmt.Errorf("get order for cancellation %s: %w", id, err)
	}

	if order.Status == StatusShipped || order.Status == StatusDelivered {
		return fmt.Errorf("cannot cancel order in status %s", order.Status)
	}

	order.Status = StatusCancelled
	order.Notes = reason
	order.UpdatedAt = time.Now().UTC()

	if err := s.repo.Update(ctx, order); err != nil {
		return fmt.Errorf("update order %s for cancellation: %w", id, err)
	}

	s.logger.Printf("order cancelled: id=%s reason=%s", id, reason)
	return nil
}

// validateOrder checks that an order has all required fields.
func (s *Service) validateOrder(order *Order) error {
	if order.CustomerID == "" {
		return errors.New("customer_id is required")
	}
	if len(order.Items) == 0 {
		return errors.New("order must contain at least one item")
	}
	for i, item := range order.Items {
		if item.ProductID == "" {
			return fmt.Errorf("item %d: product_id is required", i)
		}
		if item.Quantity <= 0 {
			return fmt.Errorf("item %d: quantity must be positive", i)
		}
		if item.UnitCents <= 0 {
			return fmt.Errorf("item %d: unit_cents must be positive", i)
		}
	}
	if order.ShippingAddr.Street == "" || order.ShippingAddr.City == "" {
		return errors.New("shipping address is incomplete")
	}
	return nil
}

// calculateTotal computes the total cost in cents for a list of order items.
func (s *Service) calculateTotal(items []OrderItem) int64 {
	var total int64
	for _, item := range items {
		total += item.UnitCents * int64(item.Quantity)
	}
	return total
}

// generateID creates a new unique order identifier.
func generateID() string {
	return fmt.Sprintf("ord_%d", time.Now().UnixNano())
}`,
    requirements: {
      must_not_include: ['```', 'package ', 'type Service struct'],
      quality_notes:
        'Cursor is inside CreateOrder() after setting up the order fields and computing the total. The suffix immediately logs and sends a notification, so the completion should persist the order to the repository (s.repo.Create) and handle the error. Should use idiomatic Go error wrapping with fmt.Errorf and %w. Keep it concise — just the repo call and error check. Must use tab indentation.',
    },
    saturation: { prefix: 'saturated', suffix: 'saturated' },
  },

  // ── Rust: Parser module ─────────────────────────────────────────────

  {
    id: 'code-mid-file-rs-full',
    description: 'Rust parser module, cursor in a match arm body',
    mode: 'code' as const,
    languageId: 'rust',
    fileName: 'parser.rs',
    prefix: `/// Errors that can occur during lexing or parsing.
#[derive(Debug, Clone)]
pub struct ParseError {
    pub message: String,
    pub line: usize,
    pub column: usize,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}: {}", self.line, self.column, self.message)
    }
}

impl std::error::Error for ParseError {}

type Result<T> = std::result::Result<T, ParseError>;

/// Lexer converts source text into a stream of tokens.
pub struct Lexer<'a> {
    input: Peekable<Chars<'a>>,
    line: usize,
    column: usize,
}

impl<'a> Lexer<'a> {
    pub fn new(source: &'a str) -> Self {
        Lexer {
            input: source.chars().peekable(),
            line: 1,
            column: 1,
        }
    }

    fn advance(&mut self) -> Option<char> {
        let ch = self.input.next();
        if let Some(c) = ch {
            if c == '\\n' {
                self.line += 1;
                self.column = 1;
            } else {
                self.column += 1;
            }
        }
        ch
    }

    fn peek(&mut self) -> Option<&char> {
        self.input.peek()
    }

    fn skip_whitespace(&mut self) {
        while let Some(&ch) = self.peek() {
            if ch.is_whitespace() {
                self.advance();
            } else if ch == '/' {
                // Check for line comments
                let mut clone = self.input.clone();
                clone.next();
                if clone.peek() == Some(&'/') {
                    // Skip until end of line
                    while let Some(&c) = self.peek() {
                        if c == '\\n' {
                            break;
                        }
                        self.advance();
                    }
                } else {
                    break;
                }
            } else {
                break;
            }
        }
    }

    fn read_string(&mut self) -> Result<Token> {
        let mut s = String::new();
        let start_line = self.line;
        let start_col = self.column;

        loop {
            match self.advance() {
                Some('"') => return Ok(Token::StringLit(s)),
                Some('\\\\') => match self.advance() {
                    Some('n') => s.push('\\n'),
                    Some('t') => s.push('\\t'),
                    Some('\\\\') => s.push('\\\\'),
                    Some('"') => s.push('"'),
                    Some(c) => s.push(c),
                    None => {
                        return Err(ParseError {
                            message: "unterminated escape in string".into(),
                            line: start_line,
                            column: start_col,
                        })
                    }
                },
                Some(c) => s.push(c),
                None => {
                    return Err(ParseError {
                        message: "unterminated string literal".into(),
                        line: start_line,
                        column: start_col,
                    })
                }
            }
        }
    }

    fn read_number(&mut self, first: char) -> Result<Token> {
        let mut num_str = String::from(first);
        let mut is_float = false;

        while let Some(&ch) = self.peek() {
            if ch.is_ascii_digit() {
                num_str.push(ch);
                self.advance();
            } else if ch == '.' && !is_float {
                is_float = true;
                num_str.push(ch);
                self.advance();
            } else {
                break;
            }
        }

`,
    suffix: `    }

    fn read_identifier(&mut self, first: char) -> Token {
        let mut ident = String::from(first);
        while let Some(&ch) = self.peek() {
            if ch.is_alphanumeric() || ch == '_' {
                ident.push(ch);
                self.advance();
            } else {
                break;
            }
        }

        match ident.as_str() {
            "let" => Token::Let,
            "fn" => Token::Fn,
            "if" => Token::If,
            "else" => Token::Else,
            "return" => Token::Return,
            "while" => Token::While,
            "true" => Token::Boolean(true),
            "false" => Token::Boolean(false),
            "null" => Token::Null,
            _ => Token::Ident(ident),
        }
    }

    /// Produce the next token from the input.
    pub fn next_token(&mut self) -> Result<Token> {
        self.skip_whitespace();

        let line = self.line;
        let col = self.column;

        match self.advance() {
            None => Ok(Token::Eof),
            Some('+') => Ok(Token::Plus),
            Some('-') => {
                if self.peek() == Some(&'>') {
                    self.advance();
                    Ok(Token::Arrow)
                } else {
                    Ok(Token::Minus)
                }
            }
            Some('*') => Ok(Token::Star),
            Some('/') => Ok(Token::Slash),
            Some('%') => Ok(Token::Percent),
            Some('=') => {
                if self.peek() == Some(&'=') {
                    self.advance();
                    Ok(Token::EqEq)
                } else {
                    Ok(Token::Eq)
                }
            }
            Some('!') => {
                if self.peek() == Some(&'=') {
                    self.advance();
                    Ok(Token::BangEq)
                } else {
                    Ok(Token::Bang)
                }
            }
            Some('<') => {
                if self.peek() == Some(&'=') {
                    self.advance();
                    Ok(Token::LtEq)
                } else {
                    Ok(Token::Lt)
                }
            }
            Some('>') => {
                if self.peek() == Some(&'=') {
                    self.advance();
                    Ok(Token::GtEq)
                } else {
                    Ok(Token::Gt)
                }
            }
            Some('(') => Ok(Token::LParen),
            Some(')') => Ok(Token::RParen),
            Some('{') => Ok(Token::LBrace),
            Some('}') => Ok(Token::RBrace),
            Some('[') => Ok(Token::LBracket),
            Some(']') => Ok(Token::RBracket),
            Some(',') => Ok(Token::Comma),
            Some(';') => Ok(Token::Semicolon),
            Some(':') => Ok(Token::Colon),
            Some('.') => Ok(Token::Dot),
            Some('"') => self.read_string(),
            Some(c) if c.is_ascii_digit() => self.read_number(c),
            Some(c) if c.is_alphabetic() || c == '_' => Ok(self.read_identifier(c)),
            Some(c) => Err(ParseError {
                message: format!("unexpected character: '{}'", c),
                line,
                column: col,
            }),
        }
    }

    /// Tokenize the entire input into a vector of tokens.
    pub fn tokenize(&mut self) -> Result<Vec<Token>> {
        let mut tokens = Vec::new();
        loop {
            let token = self.next_token()?;
            if token == Token::Eof {
                tokens.push(token);
                break;
            }
            tokens.push(token);
        }
        Ok(tokens)
    }`,
    requirements: {
      must_not_include: ['```', 'pub struct Lexer', 'pub enum Token'],
      quality_notes:
        'Cursor is at the end of the read_number method, after the while loop that collects digits and an optional decimal point. Should parse the accumulated num_str into either an i64 (Token::Integer) or f64 (Token::Float) based on the is_float flag, returning appropriate ParseError on parse failure. Use idiomatic Rust with Result handling (map_err or match). Must use 8-space indentation (inside impl block method body).',
    },
    saturation: { prefix: 'saturated', suffix: 'saturated' },
  },
];
