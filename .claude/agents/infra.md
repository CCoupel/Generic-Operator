# Infra — spécificités Secure Namespace Operator

> Complète `infra.template.md` (générique). Ce projet n'a **ni Dockerfile ni docker-compose** — c'est
> un chart Helm pur distribué en OCI, le principe BORE/Docker du template générique ne s'applique pas ici.
>
> Le repo sépare `templates/core/` (moteur générique, **jamais touché par toi** — domaine de
> `dev-backend`) de `templates/implementations/<nom>/` (une implémentation par CRD géré — c'est ton
> domaine). Aujourd'hui une seule implémentation existe : `secure-namespace`.

## Périmètre

| Domaine | Fichiers |
|---|---|
| Chart (racine, partagé) | `CHARTS/Chart.yaml`, `CHARTS/values.yaml` (dont `crd.group/version/kind/plural`), `CHARTS/templates/_helpers.tpl` |
| CRD | `CHARTS/templates/implementations/secure-namespace/CRD/0_CRD.yml` — schéma `SecureNamespace`, group/version/kind/plural tous tirés de `{{ .Values.crd.* }}` (aucun literal en dur) |
| RBAC | `CHARTS/templates/implementations/secure-namespace/RBAC/10_roles.yaml` |
| Kyverno | `CHARTS/templates/implementations/secure-namespace/KYVERNO_rules/*.yaml` — `ClusterPolicy` Validate/Mutate pour Ingress et SecureNamespace |
| Templates embarqués (Jinja2) | `CHARTS/templates/implementations/secure-namespace/TEMPLATES/*.yml`, `CHARTS/templates/implementations/secure-namespace/CONTROLER/TEMPLATES/*.yml` |
| Deployment du moteur (ne pas toucher — `dev-backend`/partagé) | `CHARTS/templates/core/10_deployment.yml` — c'est lui qui injecte `CRD_GROUP`/`CRD_VERSION`/`CRD_PLURAL` depuis `values.yaml::crd` |
| CI/CD | `.github/workflows/release.yml` (GitHub Actions) |
| Exemples (CR à `kubectl apply`) | `CHARTS/examples/*.yml` — ne pas confondre avec `templates/implementations/` (ça, c'est le code de l'implémentation, pas des instances) |

## Deux couches de templating — ne jamais les confondre

Les fichiers sous `TEMPLATES/` sont rendus **deux fois** :

1. **Helm** (`helm install`/`helm template`) — syntaxe standard `{{ .Values.x }}`, `{{- include ... }}`.
   C'est la seule couche que `infra` édite directement.
2. **Jinja2 runtime** (par l'opérateur Python, cf. `dev-backend`) — délimiteurs **personnalisés** pour
   éviter la collision avec Helm :
   - Variables : `[{ solution }]`
   - Blocs : `[% if ... %]` / `[% endif %]`
   - Commentaires : `[# ... #]`

Quand tu écris un template K8s destiné à être rendu par l'opérateur (namespace, NetworkPolicy, Ingress
par exemple), utilise `[{ }]`/`[% %]`, jamais `{{ }}` (qui serait consommé par Helm avant même d'atteindre
l'opérateur). Les valeurs disponibles dans ce second rendu sont définies côté Python par
`template_manager.py::get_template_values()` — pour ajouter une nouvelle variable de template, coordonner
avec `dev-backend`.

## CRD (`implementations/secure-namespace/CRD/0_CRD.yml`)

- Groupe/version/kind/plural **tous** rendus depuis `{{ .Values.crd.group }}` / `.version` / `.kind` /
  `.plural` (par défaut : `secure-ns.example.com` / `v1alpha1` / `SecureNamespace` / `securenamespaces`)
  — y compris `metadata.name: {{ .Values.crd.plural }}.{{ .Values.crd.group }}`. Ne jamais réintroduire
  un de ces littéraux en dur ici : si tu ajoutes un nouveau fichier qui référence le CRD, utilise ces
  mêmes variables Helm
- Toute nouvelle propriété `spec.*` doit avoir un `default` explicite dans le schema OpenAPI v3
  (le code Python lit les defaults via `crd_manager.py::extract_defaults_from_crd`, pas de valeur
  en dur côté Python)
- Le CRD est annoté `helm.sh/resource-policy: keep` — `helm uninstall` ne le supprime pas
  (documenté dans `CHARTS/README.md`)

## RBAC (`implementations/secure-namespace/RBAC/10_roles.yaml`)

- Least privilege : un nouveau besoin d'accès (verbe/resource K8s) côté opérateur doit être ajouté ici
  explicitement, jamais supposé déjà couvert par un wildcard existant
- Les règles ciblant le CRD lui-même utilisent `apiGroups: ["{{ .Values.crd.group }}"]` — jamais le
  literal `secure-ns.example.com`
- Vérifier la cohérence avec les appels `resource_manager.py` côté `dev-backend` avant de valider une PR

## Kyverno (`implementations/secure-namespace/KYVERNO_rules/`)

- `securenamespace-Validate.yaml` / `securenamespace-Mutate.yaml` : contrôle admission sur les CR
  `SecureNamespace`, matchent sur `{{ .Values.crd.group }}/{{ .Values.crd.version }}/{{ .Values.crd.kind }}`
- `Ingress-Validate.yaml` / `Ingress-Mutate.yaml` : impose que les hosts externes d'un namespace managé
  (label `{{ .Values.crd.group }}/managed: "true"`) se terminent par `.{{ .Values.crd.group }}` — c'est
  un **deuxième** usage du domaine `crd.group` (au-delà du group CRD lui-même), comme convention "ce host
  nous appartient". Le domaine ingress "normal" (généré depuis `<environment>.<solution>`) reste
  `values.yaml::dnsDomain`, distinct. Attention à ces deux couches de templating imbriquées dans ces
  fichiers : Kyverno a sa PROPRE syntaxe `{{ }}` échappée en `{{ "{{" }}` / `{{ "}}" }}` pour survivre au
  rendu Helm — insérer `{{ .Values.crd.group }}` DANS une expression Kyverno déjà échappée fonctionne
  (c'est juste du texte Helm normal entre les échappements), mais ne jamais déséchapper par erreur
- `kyverno-rbac.yaml` : `apiGroups`/`resources` sur `{{ .Values.crd.group }}`/`{{ .Values.crd.plural }}`
- Valider une policy avant commit : `kyverno apply <policy>.yaml --resource <test-resource>.yaml` si l'outil `kyverno` CLI est disponible, sinon documenter le test manuel dans le rapport
- Vérification systématique après toute modif touchant ces fichiers : `helm template ./CHARTS` doit
  produire des `ClusterPolicy` identiques à avant modif quand `values.crd.*` garde ses valeurs par
  défaut (sinon l'échappement Kyverno a probablement été cassé)

## CI/CD (`.github/workflows/release.yml`)

GitHub Actions (pas GitLab CI — le repo vit sur GitHub, `.gitlab-ci.yml` a été retiré car il n'avait
aucun effet ici sans mirroir GitLab). Deux jobs :

1. `lint` (sur chaque push vers `main` et chaque PR) → `helm lint ./CHARTS` + `helm template ./CHARTS`
2. `package-and-publish` (uniquement sur tag `vX.Y.Z`, après `lint`) → bump `Chart.yaml` depuis
   `GITHUB_REF_NAME`, `helm package`, puis `helm push` vers `oci://ghcr.io/${OWNER}/charts` (registre
   OCI GitHub Container Registry, même pattern que le projet `ansible-builder`)

Contrairement à l'ancien pipeline GitLab, **aucune configuration manuelle de secret n'est nécessaire** :
`secrets.GITHUB_TOKEN` est fourni nativement par GitHub Actions à chaque run, avec `permissions:
packages: write` déclaré dans le job. Vérifié en conditions réelles (tag `v0.0.2`) : le package ghcr.io
créé via ce token est directement **public** (hérite de la visibilité du repo, contrairement à un push
via PAT manuel qui le crée sous le compte utilisateur en privé) — `helm pull` anonyme fonctionne sans
étape manuelle supplémentaire dans Settings → Packages.

Une fois publié, le chart est installable directement en OCI (chemin toujours en minuscules, ex `ccoupel`
et non `CCoupel` — contrainte de la spec OCI distribution) :
```
helm install secure-namespace-operator oci://ghcr.io/ccoupel/charts/secure-namespace-operator --version <X.Y.Z>
```
Rancher (App → Repositories, type OCI) peut pointer directement sur `oci://ghcr.io/<owner>/charts`.

## Frontière avec `dev-backend`

Ligne de partage simple : tout le code Python (opérateur **et** contrôleur VIP) vit sous `templates/core/`
et appartient à `dev-backend` ; tout ce qui est déclaratif (CRD, RBAC, Kyverno, templates Jinja2, y
compris ceux du contrôleur VIP) vit sous `templates/implementations/<nom>/` et est ton domaine :

| Toi (`infra`) — `implementations/*/` + racine chart | `dev-backend` — `core/` |
|---|---|
| `Chart.yaml`, `values.yaml` (dont `crd.*`), `_helpers.tpl` | Opérateur (`core/CODE/3_operator.yml`) |
| Contenu des templates rendus (`implementations/*/TEMPLATES/*.yml`, y compris `CONTROLER/TEMPLATES/`) | VIP Controller (`core/CODE/2_VIP-controller.yml`) |
| Schéma CRD (`implementations/*/CRD/0_CRD.yml`) | Appels à `render_template()` / structure des `values` Jinja2 |
| RBAC (`implementations/*/RBAC/`), Kyverno (`implementations/*/KYVERNO_rules/`), `.github/workflows/release.yml` | Lecture des champs `spec.*` via `crd_manager.py` |

Si une tâche touche les deux périmètres (ex: nouveau champ CRD utilisé par le code), le CDP dispatch
en séquence : toi (schéma CRD) → `dev-backend` (lecture/usage du champ).
