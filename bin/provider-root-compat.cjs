#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function createProviderRootCompat(providerLabels) {
  const weakLayoutMarkers = Object.freeze([
    Object.freeze({
      label: 'skills/autoprompt/SKILL.md',
      check(root) {
        return matchAnchoredFile(root, ['skills', 'autoprompt', 'SKILL.md'])
      },
    }),
    Object.freeze({
      label: 'agents/ap-*.md',
      check(root) {
        return matchAnchoredPatternAny(root, ['agents'], /^ap-.*\.md$/)
      },
    }),
  ])

  const providerLayouts = Object.freeze({
    claude: Object.freeze({
      markers: Object.freeze([
        Object.freeze({
          label: 'agents/ap-*.md (25 files)',
          shared: true,
          check(root) {
            return matchAnchoredPatternCount(root, ['agents'], /^ap-.*\.md$/, 25)
          },
        }),
        Object.freeze({
          label: 'skills/autoprompt/workflow/autoprompt-gate.js',
          check(root) {
            return matchAnchoredFile(root, ['skills', 'autoprompt', 'workflow', 'autoprompt-gate.js'])
          },
        }),
        Object.freeze({
          label: 'skills/autoprompt/autoprompt-models.schema.md',
          check(root) {
            return matchAnchoredFile(root, ['skills', 'autoprompt', 'autoprompt-models.schema.md'])
          },
        }),
      ]),
    }),
    codex: Object.freeze({
      markers: Object.freeze([
        Object.freeze({
          label: 'autoprompt.config.toml',
          check(root) {
            return matchAnchoredFile(root, ['autoprompt.config.toml'])
          },
        }),
        Object.freeze({
          label: 'skills/autoprompt/agents-runtime/ap-*.toml (25 files)',
          check(root) {
            return matchAnchoredPatternCount(
              root,
              ['skills', 'autoprompt', 'agents-runtime'],
              /^ap-.*\.toml$/,
              25,
            )
          },
        }),
        Object.freeze({
          label: 'skills/autoprompt/agents-runtime/.autoprompt-casting.json',
          check(root) {
            return matchAnchoredFile(
              root,
              ['skills', 'autoprompt', 'agents-runtime', '.autoprompt-casting.json'],
            )
          },
        }),
      ]),
    }),
    opencode: Object.freeze({
      markers: Object.freeze([
        Object.freeze({
          label: 'autoprompt.opencode.json',
          check(root) {
            return matchAnchoredJsonSchema(
              root,
              ['autoprompt.opencode.json'],
              'https://opencode.ai/config.json',
            )
          },
        }),
        Object.freeze({
          label: 'agents/ap-*.md (25 files)',
          shared: true,
          check(root) {
            return matchAnchoredPatternCount(root, ['agents'], /^ap-.*\.md$/, 25)
          },
        }),
        Object.freeze({
          label: 'skills/autoprompt/workflow/launch-opencode.sh',
          check(root) {
            return matchAnchoredFile(root, ['skills', 'autoprompt', 'workflow', 'launch-opencode.sh'])
          },
        }),
        Object.freeze({
          label: 'skills/autoprompt/workflow/launch-opencode.ps1',
          check(root) {
            return matchAnchoredFile(root, ['skills', 'autoprompt', 'workflow', 'launch-opencode.ps1'])
          },
        }),
      ]),
    }),
    kilo: Object.freeze({
      markers: Object.freeze([
        Object.freeze({
          label: 'autoprompt.kilo.json',
          check(root) {
            return matchAnchoredJsonSchema(
              root,
              ['autoprompt.kilo.json'],
              'https://app.kilo.ai/config.json',
            )
          },
        }),
        Object.freeze({
          label: 'agents/ap-*.md (25 files)',
          shared: true,
          check(root) {
            return matchAnchoredPatternCount(root, ['agents'], /^ap-.*\.md$/, 25)
          },
        }),
      ]),
    }),
    vscode: Object.freeze({
      externalWarning: 'The required VS Code subagent setting cannot be verified from this provider root.',
      markers: Object.freeze([
        Object.freeze({
          label: 'agents/ap-*.agent.md (25 files)',
          check(root) {
            return matchAnchoredPatternCount(root, ['agents'], /^ap-.*\.agent\.md$/, 25)
          },
        }),
      ]),
    }),
    prime: Object.freeze({
      markers: Object.freeze([
        Object.freeze({
          label: '.autoprompt-prime-install.json',
          check(root) {
            return matchAnchoredFile(root, ['.autoprompt-prime-install.json'])
          },
        }),
        Object.freeze({
          label: 'settings.json',
          check(root) {
            return matchAnchoredFile(root, ['settings.json'])
          },
        }),
        Object.freeze({
          label: 'autoprompt/packages/prime/package.json#prime-agent',
          check(root) {
            return matchAnchoredPrimePackage(
              root,
              ['autoprompt', 'packages', 'prime', 'package.json'],
            )
          },
        }),
        Object.freeze({
          label: 'autoprompt/packages/prime/skills/autoprompt/src/autoprompt/__init__.py',
          check(root) {
            return matchAnchoredFile(
              root,
              ['autoprompt', 'packages', 'prime', 'skills', 'autoprompt', 'src', 'autoprompt', '__init__.py'],
            )
          },
        }),
      ]),
    }),
    omp: Object.freeze({
      markers: Object.freeze([
        Object.freeze({
          label: 'skills/autoprompt/SKILL.md (OMP invocation)',
          check(root) {
            return matchAnchoredOmpSkill(root, ['skills', 'autoprompt', 'SKILL.md'])
          },
        }),
        Object.freeze({
          label: 'agents/ap-*.md (25 files)',
          shared: true,
          check(root) {
            return matchAnchoredPatternCount(root, ['agents'], /^ap-.*\.md$/, 25)
          },
        }),
      ]),
    }),
    deepseek: Object.freeze({
      markers: Object.freeze([
        Object.freeze({
          label: '.agent-presets/autoprompt/agent.cordis.yml',
          check(root) {
            return matchAnchoredFile(
              root,
              ['.agent-presets', 'autoprompt', 'agent.cordis.yml'],
            )
          },
        }),
        Object.freeze({
          label: '.agent-presets/autoprompt/preset.yml',
          check(root) {
            return matchAnchoredFile(root, ['.agent-presets', 'autoprompt', 'preset.yml'])
          },
        }),
      ]),
    }),
    reasonix: Object.freeze({
      markers: Object.freeze([
        Object.freeze({
          label: 'skills/ap-*/SKILL.md (25 files)',
          shared: true,
          check(root) {
            return matchAnchoredNestedFileCount(
              root,
              ['skills'],
              /^ap-.*$/,
              'SKILL.md',
              25,
            )
          },
        }),
      ]),
    }),
    hermes: Object.freeze({
      markers: Object.freeze([
        Object.freeze({
          label: 'skills/ap-*/SKILL.md (25 files)',
          shared: true,
          check(root) {
            return matchAnchoredNestedFileCount(
              root,
              ['skills'],
              /^ap-.*$/,
              'SKILL.md',
              25,
            )
          },
        }),
      ]),
    }),
  })

  return Object.freeze({
    inspect(root, providerId) {
      const evidence = collectProviderLayoutEvidence(root, providerLayouts, weakLayoutMarkers)
      if (evidence.unsafe) return { status: 'unsafe' }

      const selected = evidence.providers[providerId]
      const selectedLayout = providerLayouts[providerId]
      const hasOtherMarkers = Object.entries(evidence.providers).some(
        ([id, layout]) => id !== providerId && (
          layout.uniqueMatches.length > 0 || layout.uniquePartial.length > 0
        ),
      )
      if (selected.complete && !hasOtherMarkers && !selectedLayout.externalWarning) {
        return { status: 'accept' }
      }
      if (selected.complete && !hasOtherMarkers && selectedLayout.externalWarning) {
        return {
          status: 'warn',
          headline: `Warning: ${selectedLayout.externalWarning}`,
          details: [`Found selected-provider markers: ${selected.matches.join(', ')}`],
        }
      }

      const warning = layoutWarning(providerId, evidence, providerLabels)
      return { status: 'warn', ...warning }
    },
    resolveInput(value, options) {
      let requested = unquote(String(value || ''))
      if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069"]/.test(requested)) {
        return { status: 'invalid' }
      }

      const home = configuredHome(options.env)
      if (requested === '~') requested = home
      else if (requested.startsWith('~/') || requested.startsWith('~\\')) {
        requested = path.join(home, requested.slice(2))
      }

      if (!requested) return { status: 'empty' }

      const resolved = path.resolve(options.cwd, requested)
      if (resolved === path.parse(resolved).root) return { status: 'unsafe' }
      const rootInfo = tryLstat(resolved)
      if (!rootInfo.found) return { status: 'missing' }
      if (rootInfo.stats.isSymbolicLink()) return { status: 'unsafe' }
      if (!rootInfo.stats.isDirectory()) return { status: 'not-directory' }
      return { status: 'ok', root: resolved }
    },
  })
}

function configuredHome(env, fallback = os.homedir()) {
  return env.HOME || env.USERPROFILE || fallback
}

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0]
    const last = value.at(-1)
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim()
    }
  }
  return value
}

function tryLstat(target) {
  try {
    return { found: true, stats: fs.lstatSync(target) }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { found: false, stats: null }
    throw error
  }
}

function anchoredTarget(root, segments) {
  const rootInfo = tryLstat(root)
  if (!rootInfo.found) return { status: 'missing', absolutePath: root }
  if (rootInfo.stats.isSymbolicLink()) return { status: 'unsafe', absolutePath: root }
  if (!rootInfo.stats.isDirectory()) return { status: 'missing', absolutePath: root }

  let current = root
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index])
    const info = tryLstat(current)
    if (!info.found) return { status: 'missing', absolutePath: current }
    if (info.stats.isSymbolicLink()) return { status: 'unsafe', absolutePath: current }
    if (index < segments.length - 1 && !info.stats.isDirectory()) {
      return { status: 'missing', absolutePath: current }
    }
    if (index === segments.length - 1) {
      return { status: 'match', absolutePath: current, stats: info.stats }
    }
  }
  return { status: 'match', absolutePath: root, stats: rootInfo.stats }
}

function matchAnchoredFile(root, segments) {
  const target = anchoredTarget(root, segments)
  if (target.status !== 'match') return target
  return target.stats.isFile() ? target : { status: 'missing', absolutePath: target.absolutePath }
}

function matchAnchoredPatternCount(root, segments, pattern, expectedCount) {
  const target = anchoredTarget(root, segments)
  if (target.status !== 'match') return target
  if (!target.stats.isDirectory()) {
    return { status: 'missing', absolutePath: target.absolutePath }
  }

  let matches = 0
  for (const entry of fs.readdirSync(target.absolutePath, { withFileTypes: true })) {
    if (!pattern.test(entry.name)) continue
    const childPath = path.join(target.absolutePath, entry.name)
    const childInfo = tryLstat(childPath)
    if (!childInfo.found) continue
    if (childInfo.stats.isSymbolicLink()) return { status: 'unsafe', absolutePath: childPath }
    if (childInfo.stats.isFile()) matches += 1
  }

  if (matches === 0) return { status: 'missing', absolutePath: target.absolutePath }
  if (matches === expectedCount) return { status: 'match', absolutePath: target.absolutePath }
  return { status: 'partial', absolutePath: target.absolutePath }
}

function matchAnchoredPatternAny(root, segments, pattern) {
  const target = anchoredTarget(root, segments)
  if (target.status !== 'match') return target
  if (!target.stats.isDirectory()) {
    return { status: 'missing', absolutePath: target.absolutePath }
  }

  for (const entry of fs.readdirSync(target.absolutePath, { withFileTypes: true })) {
    if (!pattern.test(entry.name)) continue
    const childPath = path.join(target.absolutePath, entry.name)
    const childInfo = tryLstat(childPath)
    if (!childInfo.found) continue
    if (childInfo.stats.isSymbolicLink()) return { status: 'unsafe', absolutePath: childPath }
    if (childInfo.stats.isFile()) return { status: 'match', absolutePath: childPath }
  }
  return { status: 'missing', absolutePath: target.absolutePath }
}

function matchAnchoredJsonSchema(root, segments, schema) {
  const target = matchAnchoredFile(root, segments)
  if (target.status !== 'match') return target
  try {
    const parsed = JSON.parse(fs.readFileSync(target.absolutePath, 'utf8'))
    return parsed && parsed.$schema === schema
      ? target
      : { status: 'partial', absolutePath: target.absolutePath }
  } catch {
    return { status: 'partial', absolutePath: target.absolutePath }
  }
}

function matchAnchoredOmpSkill(root, segments) {
  const target = matchAnchoredFile(root, segments)
  if (target.status !== 'match') return target
  try {
    const text = fs.readFileSync(target.absolutePath, 'utf8')
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
    if (!frontmatter) return { status: 'partial', absolutePath: target.absolutePath }
    const metadata = frontmatter[1]
    const isAutoprompt = /^name:\s*["']?autoprompt["']?\s*$/m.test(metadata)
    const hasInvocation = /^description:\s*[^\r\n]*\/skill:autoprompt(?![A-Za-z0-9_:/-])/m.test(metadata)
    const isUserInvocable = /^user-invocable:\s*true\s*$/m.test(metadata)
    return isAutoprompt && hasInvocation && isUserInvocable
      ? target
      : { status: 'partial', absolutePath: target.absolutePath }
  } catch {
    return { status: 'partial', absolutePath: target.absolutePath }
  }
}

function matchAnchoredNestedFileCount(root, segments, directoryPattern, filename, expectedCount) {
  const target = anchoredTarget(root, segments)
  if (target.status !== 'match') return target
  if (!target.stats.isDirectory()) {
    return { status: 'missing', absolutePath: target.absolutePath }
  }
  let matches = 0
  for (const entry of fs.readdirSync(target.absolutePath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !directoryPattern.test(entry.name)) continue
    const directory = path.join(target.absolutePath, entry.name)
    const directoryInfo = tryLstat(directory)
    if (!directoryInfo.found) continue
    if (directoryInfo.stats.isSymbolicLink()) {
      return { status: 'unsafe', absolutePath: directory }
    }
    const child = matchAnchoredFile(directory, [filename])
    if (child.status === 'unsafe') return child
    if (child.status === 'match') matches += 1
  }
  if (matches === 0) return { status: 'missing', absolutePath: target.absolutePath }
  if (matches === expectedCount) return { status: 'match', absolutePath: target.absolutePath }
  return { status: 'partial', absolutePath: target.absolutePath }
}

function matchAnchoredPrimePackage(root, segments) {
  const target = matchAnchoredFile(root, segments)
  if (target.status !== 'match') return target
  try {
    const parsed = JSON.parse(fs.readFileSync(target.absolutePath, 'utf8'))
    const keywords = Array.isArray(parsed.keywords) ? parsed.keywords : []
    const peers = parsed.peerDependencies && typeof parsed.peerDependencies === 'object'
      ? parsed.peerDependencies
      : {}
    return keywords.includes('prime-agent') || Object.prototype.hasOwnProperty.call(
      peers,
      '@earendil-works/pi-coding-agent',
    )
      ? target
      : { status: 'partial', absolutePath: target.absolutePath }
  } catch {
    return { status: 'partial', absolutePath: target.absolutePath }
  }
}

function collectProviderLayoutEvidence(root, providerLayouts, weakLayoutMarkers) {
  const providers = {}
  let unsafe = false

  for (const [providerId, layout] of Object.entries(providerLayouts)) {
    const matches = []
    const partial = []
    const uniqueMatches = []
    const uniquePartial = []
    for (const marker of layout.markers) {
      const result = marker.check(root)
      if (result.status === 'unsafe') {
        unsafe = true
        break
      }
      if (result.status === 'match') {
        matches.push(marker.label)
        if (!marker.shared) uniqueMatches.push(marker.label)
      } else if (result.status === 'partial') {
        partial.push(marker.label)
        if (!marker.shared) uniquePartial.push(marker.label)
      }
    }
    providers[providerId] = {
      complete: matches.length === layout.markers.length,
      matches,
      partial,
      uniqueMatches,
      uniquePartial,
    }
    if (unsafe) break
  }

  const weak = []
  if (!unsafe) {
    for (const marker of weakLayoutMarkers) {
      const result = marker.check(root)
      if (result.status === 'unsafe') {
        unsafe = true
        break
      }
      if (result.status === 'match') weak.push(marker.label)
    }
  }

  return { providers, unsafe, weak }
}

function layoutWarning(providerId, evidence, providerLabels) {
  const selectedLabel = providerLabels[providerId]
  const providers = Object.entries(evidence.providers)
  const selected = evidence.providers[providerId]
  const otherStrong = providers.filter(([id, layout]) => id !== providerId && layout.complete)
  const otherPartial = providers.filter(([id, layout]) => id !== providerId && !layout.complete && (
    layout.uniqueMatches.length > 0 || layout.uniquePartial.length > 0
  ))

  if (otherStrong.length === 1 && selected.matches.length === 0 &&
      selected.partial.length === 0 && otherPartial.length === 0) {
    return {
      headline: `Warning: this root looks like ${providerLabels[otherStrong[0][0]]}, not ${selectedLabel}.`,
      details: [`Found strong markers: ${otherStrong[0][1].matches.join(', ')}`],
    }
  }

  const details = []
  if (selected.matches.length > 0 || selected.partial.length > 0) {
    details.push(
      `Found ${selected.matches.length > 0 ? 'selected-provider' : 'partial'} markers: ` +
      [...selected.matches, ...selected.partial].join(', '),
    )
  }
  if (otherStrong.length > 0) {
    details.push(
      `Found other-provider markers: ${otherStrong.map(
        ([id, layout]) => `${providerLabels[id]} (${layout.matches.join(', ')})`,
      ).join('; ')}`,
    )
  }
  if (otherPartial.length > 0) {
    details.push(
      `Found mixed markers: ${otherPartial.map(
        ([id, layout]) => `${providerLabels[id]} (${[
          ...layout.uniqueMatches,
          ...layout.uniquePartial,
        ].join(', ')})`,
      ).join('; ')}`,
    )
  }
  if (evidence.weak.length > 0) details.push(`Found weak markers: ${evidence.weak.join(', ')}`)
  if (details.length === 0) details.push('No recognized provider markers found.')
  return {
    headline: `Warning: this root does not show a strong ${selectedLabel} layout.`,
    details,
  }
}

module.exports = { createProviderRootCompat }
