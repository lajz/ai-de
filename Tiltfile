# -*- mode: Python -*-
#
# Tilt — the local dev orchestrator for the FDE context platform.
#
#   tilt up                 backing stack + api + web + workers; dashboard at
#                           http://localhost:10350
#   tilt up -- aws          also start localstack (KMS for @fde/crypto tests)
#   tilt up -- redis        also start redis (not wired into app code yet — M3)
#   tilt up -- aws redis    both
#   tilt down               stop the apps and the compose stack (keeps volumes)
#
# Tilt drives `docker-compose` for the infra (see ./docker-compose.yml) and
# supervises the three TypeScript apps as local `pnpm dev` processes. It does
# NOT build images and does NOT use Kubernetes — prod packaging is undecided
# (the plan leans ECS Fargate; nothing is deployed yet).
#
# `tsx watch` (api) / `tsx` (workers) / `next dev` (web) each do their own file
# watching and hot-reload; Tilt just starts them in dependency order, shows
# their logs in one place, and restarts one if it crashes.

config.define_string_list('profiles', args=True)
_enabled = config.parse().get('profiles', [])
compose_profiles = [p for p in ['aws', 'redis'] if p in _enabled]

# Repo-root .env — Tilt uses it for docker-compose ${VAR} interpolation; parse
# it here too so the readiness probes / links track a remapped PORT etc.
_dotenv = {}
for _line in str(read_file('.env', default='')).splitlines():
    _line = _line.strip()
    if _line and not _line.startswith('#') and '=' in _line:
        _k, _v = _line.split('=', 1)
        _dotenv[_k.strip()] = _v.strip()

def envget(key, default):
    return _dotenv.get(key, os.getenv(key, default))

# Sourced at the top of every app/setup command so a process that doesn't read
# .env itself (workers) still gets DATABASE_URL / TEMPORAL_ADDRESS / SPICEDB_*.
LOAD_ENV = 'if [ -f .env ]; then set -a; . ./.env; set +a; fi\n'

API_PORT = int(envget('PORT', '3000'))
WEB_PORT = 3001  # apps/web `dev` script: `next dev -p 3001`

# ---------------------------------------------------------------------------
# Infra — docker-compose services, grouped under the "infra" label.
# ---------------------------------------------------------------------------
docker_compose('./docker-compose.yml', profiles=compose_profiles)

infra_services = ['postgres', 'temporal', 'spicedb']
if 'aws' in compose_profiles:
    infra_services.append('localstack')
if 'redis' in compose_profiles:
    infra_services.append('redis')

for svc in infra_services:
    svc_links = []
    if svc == 'temporal':
        svc_links = [link('http://localhost:%s' % envget('TEMPORAL_UI_PORT', '8233'), 'Temporal UI')]
    dc_resource(svc, labels=['infra'], links=svc_links)

# ---------------------------------------------------------------------------
# Setup — DB bootstrap/migrate/harden + push the SpiceDB schema. auto_init
# runs it once per `tilt up` session; TRIGGER_MODE_MANUAL keeps it from
# re-firing when an app restarts. Re-run it by hand from the dashboard (▶)
# after pulling new migrations or a schema change. The steps are idempotent.
# ---------------------------------------------------------------------------
local_resource(
    'setup',
    cmd=['bash', '-ec', LOAD_ENV + '''
pnpm db:bootstrap
pnpm db:migrate
pnpm db:harden
pnpm --filter @fde/authz schema:push
'''],
    resource_deps=['postgres', 'spicedb'],
    trigger_mode=TRIGGER_MODE_MANUAL,
    auto_init=True,
    labels=['infra'],
)

# ---------------------------------------------------------------------------
# Apps — local `pnpm dev` processes, grouped under the "apps" label.
# ---------------------------------------------------------------------------

def dev(pnpm_filter):
    return ['bash', '-ec', LOAD_ENV + 'exec pnpm --filter %s dev' % pnpm_filter]

local_resource(
    'api',
    serve_cmd=dev('@fde/api'),
    resource_deps=['setup', 'temporal'],
    readiness_probe=probe(
        period_secs=5,
        http_get=http_get_action(port=API_PORT, path='/healthz'),
    ),
    links=[link('http://localhost:%d/docs' % API_PORT, 'OpenAPI UI')],
    labels=['apps'],
)

local_resource(
    'workers',
    serve_cmd=dev('@fde/workers'),
    resource_deps=['setup', 'temporal'],
    labels=['apps'],
)

local_resource(
    'web',
    serve_cmd=dev('@fde/web'),
    resource_deps=['api'],
    readiness_probe=probe(
        period_secs=5,
        tcp_socket=tcp_socket_action(port=WEB_PORT),
    ),
    links=[link('http://localhost:%d' % WEB_PORT, 'web')],
    labels=['apps'],
)
