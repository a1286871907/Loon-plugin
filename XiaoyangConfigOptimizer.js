/* 小羊配置优化 · Loon Resource Parser */
(function () {
  "use strict";

  var VERSION = "1.1.0";
  var original = text(typeof $resource === "undefined" ? "" : $resource);
  var type = Number(typeof $resourceType === "undefined" ? -1 : $resourceType);
  var args = typeof $argument === "object" && $argument ? $argument : {};
  var options = {
    normalize: bool(args.normalize, true),
    dedupeExact: bool(args.dedupe_exact, true),
    dedupeRules: bool(args.dedupe_rules, true),
    dedupeLists: bool(args.dedupe_lists, true),
    removeConflicts: bool(args.remove_conflicts, false),
    removeShadowed: bool(args.remove_shadowed, false),
    commentInvalid: bool(args.comment_invalid, false),
    removeComments: bool(args.remove_comments, false),
    writeReport: bool(args.write_report, false),
    optimizeOther: bool(args.optimize_other, false),
    auditPlugin: bool(args.audit_plugin, true),
    crossPluginAudit: bool(args.cross_plugin_audit, false),
    notifyPluginIssues: bool(args.notify_plugin_issues, false)
  };
  var stats = {
    exact: 0,
    rule: 0,
    conflict: 0,
    conflictRemoved: 0,
    shadowed: 0,
    shadowedRemoved: 0,
    listItems: 0,
    invalid: 0,
    comments: 0,
    pluginRuleDuplicate: 0,
    pluginRulePolicy: 0,
    rewriteDuplicate: 0,
    scriptDuplicate: 0,
    tagDuplicate: 0,
    hostDuplicate: 0,
    hostConflict: 0,
    sectionDuplicate: 0,
    malformed: 0,
    unusedArgument: 0,
    crossDuplicate: 0
  };
  var auditDetails = [];

  try {
    var result = original;
    if (type === 0) result = optimizeConfig(original);
    else if (type === 2) result = optimizeRules(original);
    else if (type === 5) {
      result = options.optimizeOther ? optimizePlugin(original) : original;
      if (options.auditPlugin) {
        var fingerprints = auditPlugin(result);
        if (options.crossPluginAudit) auditAcrossPlugins(result, fingerprints);
        notifyAudit();
      }
    } else if ((type === 3 || type === 4) && options.optimizeOther) {
      result = optimizeGeneric(original);
    }

    if ((type === 0 || type === 2) && options.writeReport) {
      result = addReport(result);
    }

    if (hasContent(original) && !hasContent(result)) {
      throw new Error("优化结果为空，已触发安全回退");
    }

    console.log("[小羊配置优化] v" + VERSION + " · " + summary());
    for (var detailIndex = 0; detailIndex < auditDetails.length; detailIndex++) {
      console.log("[小羊配置优化] " + auditDetails[detailIndex]);
    }
    $done(result);
  } catch (error) {
    console.log("[小羊配置优化] 已回退原始资源：" + safeError(error));
    $done(original);
  }

  function optimizeRules(source) {
    var state = ruleState();
    var lines = linesOf(source);
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var value = ruleLine(lines[i], state);
      if (value !== null) out.push(value);
    }
    return finishLines(out);
  }

  function optimizeConfig(source) {
    var lines = linesOf(source);
    var out = [];
    var section = "ROOT";
    var seen = map();
    var rules = ruleState();

    for (var i = 0; i < lines.length; i++) {
      var line = cleanLine(lines[i]);
      var trimmed = line.trim();
      var header = /^\[([^\]]+)\]$/.exec(trimmed);

      if (header) {
        section = header[1].trim().toUpperCase();
        out.push(trimmed);
        continue;
      }
      if (!trimmed) {
        out.push("");
        continue;
      }
      if (isComment(trimmed)) {
        if (options.removeComments && trimmed.indexOf("#!") !== 0) stats.comments++;
        else out.push(line);
        continue;
      }

      if (section === "RULE") {
        var optimizedRule = ruleLine(line, rules);
        if (optimizedRule !== null) out.push(optimizedRule);
        continue;
      }

      var exactKey = "$" + section + "\n" + trimmed;
      if (options.dedupeExact && seen[exactKey]) {
        stats.exact++;
        continue;
      }
      seen[exactKey] = true;
      out.push(options.dedupeLists ? optimizeList(line) : line);
    }
    return finishLines(out);
  }

  function optimizeGeneric(source) {
    var lines = linesOf(source);
    var out = [];
    var seen = map();
    for (var i = 0; i < lines.length; i++) {
      var line = cleanLine(lines[i]);
      var key = "$" + line.trim();
      if (line.trim() && !isComment(line.trim()) && options.dedupeExact && seen[key]) {
        stats.exact++;
        continue;
      }
      if (line.trim() && !isComment(line.trim())) seen[key] = true;
      out.push(line);
    }
    return finishLines(out);
  }

  function optimizePlugin(source) {
    var lines = linesOf(source);
    var out = [];
    var section = "ROOT";
    var seen = map();
    var rules = ruleState();
    for (var i = 0; i < lines.length; i++) {
      var line = cleanLine(lines[i]);
      var trimmed = line.trim();
      var header = /^\[([^\]]+)\]$/.exec(trimmed);
      if (header) {
        section = header[1].trim().toUpperCase();
        out.push(trimmed);
        continue;
      }
      if (!trimmed || isComment(trimmed)) {
        out.push(line);
        continue;
      }
      if (section === "RULE") {
        var optimizedRule = ruleLine(line, rules);
        if (optimizedRule !== null) out.push(optimizedRule);
        continue;
      }
      var key = "$" + section + "\n" + trimmed;
      if (options.dedupeExact && seen[key]) {
        stats.exact++;
        continue;
      }
      seen[key] = true;
      out.push(options.dedupeLists ? optimizeList(line) : line);
    }
    return finishLines(out);
  }

  function auditPlugin(source) {
    var lines = linesOf(source);
    var section = "ROOT";
    var sections = map();
    var ruleSeen = map();
    var rewriteSeen = map();
    var scriptSeen = map();
    var tagSeen = map();
    var hostSeen = map();
    var fingerprints = [];
    var argumentNames = [];
    var outsideArgument = [];

    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      var header = /^\[([^\]]+)\]$/.exec(trimmed);
      if (header) {
        section = header[1].trim().toUpperCase();
        if (sections[section]) {
          stats.sectionDuplicate++;
          detail("第 " + (i + 1) + " 行：重复段落 [" + section + "]");
        }
        sections[section] = true;
        continue;
      }
      if (!trimmed || isComment(trimmed)) continue;
      if (section !== "ARGUMENT") outsideArgument.push(trimmed);
      if (/,,/.test(trimmed)) {
        stats.malformed++;
        detail("第 " + (i + 1) + " 行：出现连续逗号，请检查参数是否缺失");
      }

      if (section === "ARGUMENT") {
        var argumentMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
        if (argumentMatch) argumentNames.push(argumentMatch[1]);
      } else if (section === "RULE") {
        auditPluginRule(trimmed, i + 1, ruleSeen, fingerprints);
      } else if (section === "REWRITE") {
        auditDirective(trimmed, i + 1, "Rewrite", rewriteSeen, "rewriteDuplicate", fingerprints);
      } else if (section === "SCRIPT") {
        auditDirective(trimmed, i + 1, "Script", scriptSeen, "scriptDuplicate", fingerprints);
        auditTag(trimmed, i + 1, tagSeen);
        auditRemoteUrl(trimmed, i + 1);
      } else if (section === "HOST") {
        auditHost(trimmed, i + 1, hostSeen, fingerprints);
      } else if (section === "MITM") {
        auditMitm(trimmed, i + 1, fingerprints);
      }
    }

    var usedText = outsideArgument.join("\n");
    for (var argumentIndex = 0; argumentIndex < argumentNames.length; argumentIndex++) {
      var name = argumentNames[argumentIndex];
      if (usedText.indexOf("{" + name + "}") === -1) {
        stats.unusedArgument++;
        detail("参数 " + name + " 未在插件脚本参数中使用");
      }
    }
    return unique(fingerprints);
  }

  function auditPluginRule(line, lineNumber, seen, fingerprints) {
    var rule = parseRule(line);
    if (!rule.valid) {
      stats.invalid++;
      detail("第 " + lineNumber + " 行：插件规则格式疑似无效");
      return;
    }
    var action = rule.action ? rule.action.split(",")[0].trim().toUpperCase() : "DIRECT";
    if (!(action === "DIRECT" || action === "PROXY" || action.indexOf("REJECT") === 0)) {
      stats.pluginRulePolicy++;
      detail("第 " + lineNumber + " 行：插件规则策略 " + action + " 不属于 DIRECT/PROXY/REJECT");
    }
    var functionKey = rule.key + "\n" + action;
    if (seen[functionKey]) {
      stats.pluginRuleDuplicate++;
      detail("第 " + lineNumber + " 行：插件规则功能重复");
    }
    seen[functionKey] = true;
    fingerprints.push("rule|" + functionKey);
  }

  function auditDirective(line, lineNumber, label, seen, statName, fingerprints) {
    var key = canonicalDirective(line);
    if (seen[key]) {
      stats[statName]++;
      detail("第 " + lineNumber + " 行：" + label + " 功能疑似重复");
    }
    seen[key] = true;
    fingerprints.push(label.toLowerCase() + "|" + key);
  }

  function auditTag(line, lineNumber, seen) {
    var match = /(?:^|,)\s*tag\s*=\s*(?:"([^"]+)"|'([^']+)'|([^,]+))/i.exec(line);
    if (!match) return;
    var tag = (match[1] || match[2] || match[3] || "").trim().toLowerCase();
    if (!tag) return;
    if (seen[tag]) {
      stats.tagDuplicate++;
      detail("第 " + lineNumber + " 行：Script tag 重名（" + tag + "）");
    }
    seen[tag] = true;
  }

  function auditRemoteUrl(line, lineNumber) {
    var match = /script-path\s*=\s*(http:\/\/[^,\s]+)/i.exec(line);
    if (match) {
      stats.malformed++;
      detail("第 " + lineNumber + " 行：远程脚本使用 HTTP，建议改为 HTTPS");
    }
  }

  function auditHost(line, lineNumber, seen, fingerprints) {
    var match = /^\s*([^=\s]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) {
      stats.invalid++;
      detail("第 " + lineNumber + " 行：Host 格式疑似无效");
      return;
    }
    var hostname = match[1].toLowerCase();
    var target = match[2].toLowerCase();
    if (typeof seen[hostname] !== "undefined") {
      if (seen[hostname] === target) {
        stats.hostDuplicate++;
        detail("第 " + lineNumber + " 行：Host 映射重复（" + hostname + "）");
      } else {
        stats.hostConflict++;
        detail("第 " + lineNumber + " 行：Host 映射冲突（" + hostname + "）");
      }
    }
    seen[hostname] = target;
  }

  function auditMitm(line, lineNumber, fingerprints) {
    var match = /^\s*hostname\s*=\s*(.*)$/i.exec(line);
    if (!match) return;
    var items = match[1].split(",");
    var seen = map();
    for (var i = 0; i < items.length; i++) {
      var item = items[i].trim().toLowerCase();
      if (!item) continue;
      if (seen[item]) {
        stats.hostDuplicate++;
        detail("第 " + lineNumber + " 行：MitM hostname 重复（" + item + "）");
      }
      seen[item] = true;
    }
  }

  function canonicalDirective(line) {
    var parts = line.split(",");
    var kept = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      if (/^(tag|timeout|debug|enable|enabled)\s*=/i.test(part)) continue;
      kept.push(part.replace(/\s*=\s*/g, "=").replace(/\s+/g, " "));
    }
    return kept.join(",");
  }

  function auditAcrossPlugins(source, fingerprints) {
    if (typeof $persistentStore === "undefined" || !$persistentStore ||
        typeof $persistentStore.read !== "function" || typeof $persistentStore.write !== "function") {
      detail("跨插件检测已跳过：当前解析环境不提供持久存储");
      return;
    }
    var storageKey = "xiaoyang.config.optimizer.plugin.registry.v1";
    var registry = { entries: {} };
    try {
      var stored = $persistentStore.read(storageKey);
      if (stored) registry = JSON.parse(stored);
      if (!registry || typeof registry !== "object" || !registry.entries) registry = { entries: {} };
    } catch (error) {
      registry = { entries: {} };
    }
    var now = new Date().getTime();
    var sourceUrl = text(typeof $resourceUrl === "undefined" ? "" : $resourceUrl);
    var currentId = hashText(sourceUrl || source.slice(0, 256));
    var current = unique(fingerprints).slice(0, 500).map(function (item) { return hashText(item); });
    var currentSet = map();
    for (var i = 0; i < current.length; i++) currentSet[current[i]] = true;
    var entries = registry.entries;
    var entryKeys = Object.keys(entries);
    for (var entryIndex = 0; entryIndex < entryKeys.length; entryIndex++) {
      var entryId = entryKeys[entryIndex];
      var entry = entries[entryId];
      if (!entry || now - Number(entry.updatedAt || 0) > 30 * 24 * 60 * 60 * 1000) {
        delete entries[entryId];
        continue;
      }
      if (entryId === currentId || !entry.fingerprints) continue;
      for (var fingerprintIndex = 0; fingerprintIndex < entry.fingerprints.length; fingerprintIndex++) {
        if (currentSet[entry.fingerprints[fingerprintIndex]]) stats.crossDuplicate++;
      }
    }
    if (stats.crossDuplicate) detail("与曾解析过的其他插件发现 " + stats.crossDuplicate + " 个可能重复功能");
    entries[currentId] = {
      name: pluginName(source),
      updatedAt: now,
      fingerprints: current
    };
    trimRegistry(entries, 20);
    $persistentStore.write(JSON.stringify(registry), storageKey);
  }

  function trimRegistry(entries, limit) {
    var keys = Object.keys(entries);
    keys.sort(function (a, b) { return Number(entries[b].updatedAt || 0) - Number(entries[a].updatedAt || 0); });
    for (var i = limit; i < keys.length; i++) delete entries[keys[i]];
  }

  function pluginName(source) {
    var match = /^#!name\s*=\s*(.+)$/mi.exec(source);
    return match ? match[1].trim().slice(0, 80) : "未命名插件";
  }

  function notifyAudit() {
    var issueCount = pluginIssueCount();
    if (!options.notifyPluginIssues || !issueCount || typeof $notification === "undefined" ||
        !$notification || typeof $notification.post !== "function") return;
    $notification.post("小羊配置优化", "插件检测发现 " + issueCount + " 项", pluginAuditSummary());
  }

  function pluginIssueCount() {
    return stats.pluginRuleDuplicate + stats.pluginRulePolicy + stats.rewriteDuplicate +
      stats.scriptDuplicate + stats.tagDuplicate + stats.hostDuplicate + stats.hostConflict +
      stats.sectionDuplicate + stats.malformed + stats.unusedArgument + stats.crossDuplicate + stats.invalid;
  }

  function pluginAuditSummary() {
    return "规则重复 " + stats.pluginRuleDuplicate + "，规则策略异常 " + stats.pluginRulePolicy +
      "，Rewrite 重复 " + stats.rewriteDuplicate + "，Script 重复 " + stats.scriptDuplicate +
      "，Tag 重名 " + stats.tagDuplicate + "，Host 重复/冲突 " +
      (stats.hostDuplicate + stats.hostConflict) + "，跨插件疑似重复 " + stats.crossDuplicate;
  }

  function detail(message) {
    if (auditDetails.length < 24) auditDetails.push(message);
  }

  function unique(items) {
    var seen = map();
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var key = "$" + items[i];
      if (seen[key]) continue;
      seen[key] = true;
      out.push(items[i]);
    }
    return out;
  }

  function hashText(value) {
    var hash = 2166136261;
    var input = text(value);
    for (var i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  }

  function ruleLine(sourceLine, state) {
    var line = cleanLine(sourceLine);
    var trimmed = line.trim();
    if (!trimmed) return "";
    if (isComment(trimmed)) {
      if (options.removeComments && trimmed.indexOf("#!") !== 0) {
        stats.comments++;
        return null;
      }
      return line;
    }

    var rule = parseRule(trimmed);
    if (!rule.valid) {
      stats.invalid++;
      return options.commentInvalid ? "# [小羊疑似无效] " + trimmed : line;
    }

    var previous = state.seen[rule.key];
    if (previous) {
      if (previous.action === rule.action) {
        if (options.dedupeRules) {
          stats.rule++;
          return null;
        }
      } else {
        stats.conflict++;
        if (options.removeConflicts) {
          stats.conflictRemoved++;
          return null;
        }
      }
    } else {
      state.seen[rule.key] = { action: rule.action };
    }

    if (!previous && isDomainRule(rule)) {
      var cover = findDomainCover(rule, state.suffixes);
      if (cover) {
        stats.shadowed++;
        if (options.removeShadowed) {
          stats.shadowedRemoved++;
          return null;
        }
      }
    }

    if (!previous && rule.type === "DOMAIN-SUFFIX") {
      state.suffixes.push({ value: rule.value, action: rule.action });
    }
    return options.normalize && rule.normalizable ? rule.output : line;
  }

  function parseRule(line) {
    var first = line.indexOf(",");
    if (first <= 0 || first === line.length - 1) return { valid: false };
    var typeName = line.slice(0, first).trim().toUpperCase();
    var rest = line.slice(first + 1);
    var second = rest.indexOf(",");
    var value = (second === -1 ? rest : rest.slice(0, second)).trim();
    if (!typeName || !value) return { valid: false };

    var action = second === -1 ? "" : rest.slice(second + 1).split(",").map(trim).join(",");
    var domain = typeName === "DOMAIN" || typeName === "DOMAIN-SUFFIX" || typeName === "DOMAIN-KEYWORD";
    var normalizedValue = domain ? value.toLowerCase() : value;
    var normalizable = domain || /^(IP-CIDR|IP-CIDR6|GEOIP|IP-ASN|PROTOCOL|DEST-PORT|SRC-PORT|PORT|FINAL)$/.test(typeName);
    return {
      valid: true,
      type: typeName,
      value: normalizedValue,
      action: action,
      key: "$" + typeName + "\n" + normalizedValue,
      normalizable: normalizable,
      output: typeName + "," + value + (second === -1 ? "" : "," + action)
    };
  }

  function findDomainCover(rule, suffixes) {
    for (var i = 0; i < suffixes.length; i++) {
      var suffix = suffixes[i];
      if (suffix.action !== rule.action) continue;
      if (rule.value === suffix.value || endsWith(rule.value, "." + suffix.value)) return suffix;
    }
    return null;
  }

  function isDomainRule(rule) {
    return rule.type === "DOMAIN" || rule.type === "DOMAIN-SUFFIX";
  }

  function optimizeList(line) {
    var match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!match) return line;
    var key = match[1];
    if (!/^(bypass-tun|skip-proxy|real-ip|dns-server|doh-server|doq-server|doh3-server|hijack-dns|hostname)$/i.test(key)) {
      return line;
    }
    var items = match[2].split(",");
    var seen = map();
    var kept = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i].trim();
      if (!item) continue;
      var token = "$" + item.toLowerCase();
      if (seen[token]) {
        stats.listItems++;
        continue;
      }
      seen[token] = true;
      kept.push(item);
    }
    return key + " = " + kept.join(",");
  }

  function addReport(result) {
    var lines = linesOf(result).filter(function (line) {
      return line.indexOf("# 小羊配置优化 v") !== 0;
    });
    lines.unshift("# 小羊配置优化 v" + VERSION + "：" + summary());
    return finishLines(lines);
  }

  function summary() {
    var base = "精确重复 " + stats.exact +
      "，规则重复 " + stats.rule +
      "，策略冲突 " + stats.conflict + "（删除 " + stats.conflictRemoved + "）" +
      "，覆盖规则 " + stats.shadowed + "（删除 " + stats.shadowedRemoved + "）" +
      "，列表重复项 " + stats.listItems +
      "，疑似无效 " + stats.invalid +
      "，注释删除 " + stats.comments;
    if (type === 5 && options.auditPlugin) base += "；插件审计：" + pluginAuditSummary();
    return base;
  }

  function linesOf(value) {
    var valueText = text(value);
    if (valueText && valueText.charCodeAt(0) === 0xFEFF) valueText = valueText.slice(1);
    return valueText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  }

  function cleanLine(line) {
    line = text(line);
    return options.normalize ? line.replace(/[\t ]+$/g, "") : line;
  }

  function finishLines(lines) {
    var out = [];
    var blank = true;
    for (var i = 0; i < lines.length; i++) {
      var line = text(lines[i]);
      if (!line.trim()) {
        if (!blank) out.push("");
        blank = true;
      } else {
        out.push(line);
        blank = false;
      }
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join("\n");
  }

  function ruleState() {
    return { seen: map(), suffixes: [] };
  }

  function map() {
    return Object.create(null);
  }

  function isComment(line) {
    return line.charAt(0) === "#" || line.charAt(0) === ";";
  }

  function bool(value, fallback) {
    if (value === true || value === "true" || value === 1 || value === "1") return true;
    if (value === false || value === "false" || value === 0 || value === "0") return false;
    return fallback;
  }

  function trim(value) {
    return text(value).trim();
  }

  function text(value) {
    return value === null || typeof value === "undefined" ? "" : String(value);
  }

  function endsWith(value, suffix) {
    return value.slice(-suffix.length) === suffix;
  }

  function hasContent(value) {
    return text(value).split(/\r?\n/).some(function (line) {
      var item = line.trim();
      return item && !isComment(item);
    });
  }

  function safeError(error) {
    return text(error && error.message ? error.message : error).replace(/[\r\n]+/g, " ").slice(0, 160);
  }
})();
