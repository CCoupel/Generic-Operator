# HOWTO — Build a New Implementation on the Generic Operator Engine

This guide explains how to plug a new CRD into the generic operator engine
(`CHARTS/templates/core/`), using the bundled **secure-namespace** implementation
(`CHARTS/templates/implementations/secure-namespace/`) as the worked reference at every step.

If you just want to deploy secure-namespace as-is, see the root [`README.md`](../README.md) and
[`CHARTS/README.md`](../CHARTS/README.md) instead — this document is for building something *new*.

---

## 1. Mental model

Every resource your operator manages goes through the same pipeline, regardless of implementation:

```
CRD event (create/update/delete/timer)
        │
        ▼
handlers.py (kopf)  ──uses──▶  CRD_GROUP / CRD_VERSION / CRD_PLURAL  (values.yaml::crd)
        │
        ▼
crd_manager.py + template_manager.py  →  build a "values" dict from spec
        │
        ▼
template_manager.py::load_templates_order() + load_templates()
        │   reads a ConfigMap listing "configmap/key" pairs in execution order
        ▼
template_manager.py::render_template(template_text, values)
        │   Jinja2, CUSTOM delimiters: [{ var }]  [% if %]  [# comment #]
        ▼
resource_manager.py::apply_resource() / delete_resource()
        │   generic K8s DynamicClient — works for any apiVersion/kind
        ▼
revision_manager.py  →  bump f'{CRD_GROUP}/revision' annotation + history ConfigMap
```

### Two (really three) templating layers — never mix them up

| Layer | Syntax | Rendered by | When |
|---|---|---|---|
| Helm | `{{ .Values.x }}`, `{{- include ... }}` | `helm install`/`helm template` | Chart install/upgrade time |
| Jinja2 (engine runtime) | `[{ var }]`, `[% if %]`, `[# comment #]` | `template_manager.py::render_template()` | Every reconciliation, per CR |
| Kyverno (if you use it) | `{{ request.object... }}`, escaped in Helm as `{{ "{{" }}` / `{{ "}}" }}` | Kyverno admission controller | Every K8s API write |

A file under `templates/implementations/<name>/TEMPLATES/*.yml` is a ConfigMap whose **YAML structure**
(keys, `data:` block) is Helm syntax, but whose **data VALUES** (the manifests the operator will apply)
are Jinja2 source text using the second syntax. Using `{{ }}` there gets eaten by Helm before the
operator ever sees it — always use `[{ }]`/`[% %]` for anything meant to vary per-CR at runtime.

---

## 2. What's genuinely generic (never edit for a new implementation)

These live in `CHARTS/templates/core/CODE/3_operator.yml` and don't know what CRD they're serving:

| Module | Why it's generic |
|---|---|
| `config.py` | Reads `CRD_GROUP`/`CRD_VERSION`/`CRD_PLURAL` from env (set by `core/10_deployment.yml` from `values.yaml::crd`) |
| `handlers.py` | kopf decorators registered on `(CRD_GROUP, CRD_VERSION, CRD_PLURAL)`, not a literal kind |
| `resource_manager.py` | `apply_resource()`/`delete_resource()` use the K8s **DynamicClient** — works for any `apiVersion`/`kind` found in a rendered manifest |
| `revision_manager.py` | Revision annotation key is `f'{CRD_GROUP}/revision'`, computed, not hardcoded |
| `template_manager.py::render_template()` | Jinja2 environment with the custom delimiters — content-agnostic |
| `crd_manager.py::extract_defaults_from_crd()` | Reads `f'{CRD_PLURAL}.{CRD_GROUP}'`, walks the OpenAPI v3 schema generically |

## 3. What's still coupled to secure-namespace's spec shape (you WILL touch these)

Being precise here matters more than sounding generic: the group/version/plural wiring is fully
parameterized, but the *shape* of the values dict handed to your templates is not — it was written for
SecureNamespace's specific fields. Two functions encode that, both still in `templates/core/CODE/3_operator.yml`
today:

- **`crd_manager.py::extract_namespace_info(spec)`** — reads `spec.project.solution`,
  `spec.project.environment`, `spec.namespaceName`. If your CRD doesn't have a "solution/environment"
  concept, rewrite this function for your own fields.
- **`template_manager.py::get_template_values(spec, name, revision)`** — calls the function above, then
  builds `{'spec', 'solution', 'environment', 'namespace_name', 'securenamespace_name',
  'operator_namespace', 'revision', 'labels', 'annotations', 'domain'}`. This is the exact dict your
  Jinja2 templates receive as top-level variables (`[{ solution }]`, `[{ namespace_name }]`, etc). Adapt
  the keys to whatever your implementation's templates actually need.

One more literal you'll hit: **`load_templates_order()`** in `template_manager.py` reads a ConfigMap
named literally `secure-namespace-operator-templates-order` — not yet driven by a value. Today, a new
implementation must name its own templates-order ConfigMap exactly that (see secure-namespace's
`TEMPLATES/1.0_templates_order.yml`), or you can parameterize this one line (`os.getenv('TEMPLATES_ORDER_CONFIGMAP', ...)`,
mirroring the `CRD_GROUP` pattern) as a follow-up — it's a single line, not done here because it wasn't
in scope for this pass.

**Rule of thumb**: if `dev-backend` needs to touch `crd_manager.py`/`get_template_values()` to add a new
implementation, that's expected and fine. If they need to touch `resource_manager.py`, `revision_manager.py`,
or the kopf registration in `handlers.py`, something's wrong — those must stay implementation-agnostic.

---

## 4. Step-by-step

### Step 1 — Decide your CRD identity

Edit `values.yaml` (or a values overlay for a second implementation — see §6):

```yaml
crd:
  group: my-thing.example.com
  version: v1alpha1
  kind: MyThing
  plural: mythings
```

Reference: secure-namespace's default is `group: secure-ns.example.com`, `kind: SecureNamespace`,
`plural: securenamespaces` (`CHARTS/values.yaml`).

### Step 2 — Write your CRD

Create `CHARTS/templates/implementations/<your-name>/CRD/0_CRD.yml`. Copy the structure of
`implementations/secure-namespace/CRD/0_CRD.yml`:

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: {{ .Values.crd.plural }}.{{ .Values.crd.group }}
  namespace: {{ .Release.Namespace }}
  annotations:
    helm.sh/resource-policy: keep
spec:
  group: {{ .Values.crd.group }}
  names:
    kind: {{ .Values.crd.kind }}
    listKind: {{ .Values.crd.kind }}List
    plural: {{ .Values.crd.plural }}
    singular: {{ .Values.crd.kind | lower }}
  scope: Cluster
  versions:
  - name: {{ .Values.crd.version }}
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        # every spec.* field needs an explicit `default` —
        # crd_manager.py::extract_defaults_from_crd() relies on it, no hardcoded Python defaults
        ...
```

### Step 3 — Adapt the values-extraction functions

In `templates/core/CODE/3_operator.yml`, rewrite `extract_namespace_info()` and
`get_template_values()` for your spec's fields (see §3 above). Keep the call signature the same —
`handlers.py` and `resource_manager.py` call these by name and don't care about the dict's contents.

> If you're adding a **second** implementation alongside secure-namespace rather than replacing it,
> see §6 — today's engine is single-CRD-per-Deployment, so this step means picking which CRD this
> particular Helm release watches, not making the engine multi-CRD-aware.

### Step 4 — Write your Jinja2 templates

Create `CHARTS/templates/implementations/<your-name>/TEMPLATES/*.yml` — one ConfigMap per logical
group of resources (secure-namespace splits into `templates-core`, `templates-network`,
`templates-rbac`, etc. — one file per ConfigMap under `TEMPLATES/`). Each `data` key holds Jinja2
source using `[{ }]`/`[% %]`/`[# #]` and the variables from `get_template_values()`.

Also create the templates-order ConfigMap (see the naming caveat in §3):

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: secure-namespace-operator-templates-order   # must match load_templates_order()'s literal, for now
data:
  templates-order.yaml: |
    templates:
      - templates-core/my-resource.yaml
      - ...
```

Reference: `implementations/secure-namespace/TEMPLATES/1.1_templates_core.yml` for a simple example
(Namespace + ResourceQuota), `1.2_templates_network.yml` for something more elaborate (NetworkPolicies
built from a Python dict literal inside the Jinja2 source).

### Step 5 — RBAC

Create `CHARTS/templates/implementations/<your-name>/RBAC/10_roles.yaml`, granting the operator
ServiceAccount whatever verbs/resources your templates create or your Python code reads. Reference:
`implementations/secure-namespace/RBAC/10_roles.yaml`. Two rules are mandatory for any implementation
(swap in your own group):

```yaml
- apiGroups: ["{{ .Values.crd.group }}"]
  resources: ["{{ .Values.crd.plural }}"]
  verbs: ["get", "list", "watch", "patch"]
- apiGroups: ["{{ .Values.crd.group }}"]
  resources: ["{{ .Values.crd.plural }}/status"]
  verbs: ["get", "patch", "update", "create"]
```

### Step 6 — Admission policies (optional)

If you want validation/mutation on your CR or on resources it creates, add Kyverno `ClusterPolicy`
manifests under `implementations/<your-name>/KYVERNO_rules/`. Reference:
`implementations/secure-namespace/KYVERNO_rules/securenamespace-Validate.yaml` (validates the CR itself)
and `Ingress-Validate.yaml` (validates *other* resources based on labels the CR's namespace carries).
Remember Kyverno's own `{{ }}` must be escaped as `{{ "{{" }}` / `{{ "}}" }}` to survive Helm rendering —
see the comment block at the top of either file.

### Step 7 — A dedicated sub-controller (optional)

Only needed if part of your reconciliation can't be a one-shot template render — e.g. something that
watches cluster state continuously per-CR-instance. Reference: `core/CODE/2_VIP-controller.yml` (the VIP
egress controller — a self-contained Python app in its own ConfigMap, spawned as a Deployment by a Jinja2
template under `implementations/secure-namespace/TEMPLATES/1.7_templates_vip_controller.yml`, with its
own `CRD_GROUP` env var read independently since it doesn't share `core/`'s `config.py`).

This sub-controller lives in `core/` because its *mechanism* (load templates order → load templates →
Jinja2 render → apply/delete) is the same generic pipeline as the operator, not because its *content* is
CRD-agnostic — `controller.py`/`node_finder.py` are full of VIP/Cilium-specific reconciliation logic.
If you build your own sub-controller, either adapt that business logic for your own use case or skip
spawning one entirely — it's optional, unlike the operator itself.

### Step 8 — Validate

```bash
helm lint ./CHARTS
helm template test ./CHARTS --set crd.group=my-thing.example.com --set crd.kind=MyThing ...
```

`helm template` won't catch Jinja2-syntax errors in your `TEMPLATES/*.yml` (that's a second-pass runtime
render) — deploy to a scratch cluster and `kubectl logs -f deploy/secure-namespace-operator` while
applying a sample CR to see the real render errors.

---

## 5. Reference: file-by-file map (secure-namespace)

| What | File |
|---|---|
| CRD schema | `implementations/secure-namespace/CRD/0_CRD.yml` |
| RBAC | `implementations/secure-namespace/RBAC/10_roles.yaml` |
| Namespace/quota templates | `implementations/secure-namespace/TEMPLATES/1.1_templates_core.yml` |
| Network policy templates | `implementations/secure-namespace/TEMPLATES/1.2_templates_network.yml` |
| Ingress templates (per controller) | `implementations/secure-namespace/CONTROLER/TEMPLATES/1.4-1.6_templates_ingress_*.yml` |
| RBAC-for-created-namespace templates | `implementations/secure-namespace/TEMPLATES/1.9_templates_rbac.yml` |
| Templates execution order | `implementations/secure-namespace/TEMPLATES/1.0_templates_order.yml` |
| Sub-controller (VIP) Python code | `core/CODE/2_VIP-controller.yml` (lives in `core/` — see Step 7) |
| Sub-controller's own Jinja2 templates | `implementations/secure-namespace/CONTROLER/TEMPLATES/` |
| Kyverno policies | `implementations/secure-namespace/KYVERNO_rules/*.yaml` |
| Sample CRs to `kubectl apply` | `CHARTS/examples/*.yml` (top-level, not under `templates/`) |

---

## 6. Current limitation: one CRD per Deployment

Today `core/10_deployment.yml` runs a single operator process wired to a single `(CRD_GROUP, CRD_VERSION,
CRD_PLURAL)`. Running two implementations side-by-side means two Helm releases (two Deployments, two
`values.yaml` — one per `crd.*` block), not one release watching two CRDs. Making the engine watch
multiple CRDs from one process would mean turning `CRD_GROUP`/`VERSION`/`PLURAL` into a list and looping
handler registration — a bigger change than this pass covers; flagging it here as the natural next step
if you need it.
