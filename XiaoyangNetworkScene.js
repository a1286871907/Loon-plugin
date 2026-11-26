/* 小羊网络场景 v2.1.0 for Loon 3.5.1 (986) */
(function () {
  "use strict";

  var STORE_KEY = "xiaoyang.network.scene.state";
  var ERROR_KEY = "xiaoyang.network.scene.last_error";
  var BINDINGS_KEY = "xiaoyang.network.scene.policy_bindings";
  var MODES = { DIRECT: 0, RULE: 1, PROXY: 2 };
  var args = typeof $argument === "object" && $argument ? $argument : {};
  var tag = typeof $script === "object" && $script ? $script.name : "";
  var manualApply = tag === "立即应用当前网络场景";
  var pause = tag === "暂停当前 Wi-Fi 自动切换";
  var status = tag === "查看当前网络场景";
  var bind = tag === "把所选策略组绑定到当前 Wi-Fi";
  var unbind = tag === "取消当前 Wi-Fi 的策略组绑定";
  var manual = manualApply || pause || status || bind || unbind;
  var pauseAll = args.pause_auto === true || args.pause_auto === "true";
  var notifications = args.notifications !== false && args.notifications !== "false";
  var delay = Number(args.empty_grace_ms);
  var grace = isFinite(delay) && delay >= 200 && delay <= 3000 ? Math.round(delay) : 800;
  var leaveMode = trim(args.leave_mode).toUpperCase();
  var policyGroup, policyTarget;
  var scenes = parseScenes();
  var state;
  var resumeSSID;
  var unbound = false;

  run(false);

  function run(rechecked) {
    var waiting = false;
    try {
      if (pauseAll && !status && !bind && !unbind) {
        if (manual) announce("自动切换已暂停", "在插件设置关闭「暂停自动切换」即可恢复");
        return;
      }
      var network = readNetwork();
      var ssid = network.ssid;
      state = readState();
      var bindings = readBindings();
      if (!ssid && !status && !rechecked && (state.mode || state.policy || state.pausedSSID || manual ||
          Object.keys(bindings).length || (!scenes.error && Object.keys(scenes.entries).length))) {
        waiting = scheduleRecheck();
        return;
      }
      if ((pause || bind || (unbind && !unbound)) && !ssid) throw new Error("未读取到 Wi-Fi 名称");

      if (bind) {
        bindPolicy(ssid, bindings);
        return;
      }
      if (unbind && !unbound) {
        if (!bindings[ssid]) {
          announce("当前 Wi-Fi 没有策略组绑定", ssid);
          return;
        }
        delete bindings[ssid];
        writeBindings(bindings);
        unbound = true;
        announce("已取消策略组绑定", ssid);
      }
      var binding = ssid && bindings[ssid];
      policyGroup = binding ? binding.group : trim(args.policy_group);
      policyTarget = binding ? binding.target : trim(args.policy_target);
      var scene = binding ? "POLICY" : (ssid && !scenes.error ? scenes.entries[ssid] || "" : "");

      if (status) {
        showStatus(ssid, network.mode, scene);
        return;
      }
      if (pauseAll) return;
      if (state.mode && typeof state.mode.pending !== "undefined" && state.mode.pending !== network.mode) {
        settleMode(state.mode, network.mode);
      }
      if (pause) {
        pauseScene(network);
      } else {
        if (manualApply && typeof resumeSSID === "undefined") resumeSSID = ssid;
        if (applyScene(network, scene, binding) && !rechecked) waiting = scheduleRecheck();
      }
    } catch (error) {
      reportError(error);
    } finally {
      if (!waiting) $done();
    }
  }

  function scheduleRecheck() {
    setTimeout(function () { run(true); }, grace);
    return true;
  }

  function readNetwork() {
    var config = JSON.parse($config.getConfig());
    var rawMode = trim(config && config.running_model);
    if (!/^[012]$/.test(rawMode)) throw new Error("无法读取当前运行模式");
    return { ssid: trim(config.ssid), mode: Number(rawMode) };
  }

  function applyScene(network, scene, binding) {
    var ssid = network.ssid;
    if (state.pausedSSID) {
      if (ssid === state.pausedSSID && resumeSSID !== ssid) return;
      saveState({ pausedSSID: "" });
    }

    var issue = binding ? "" : scenes.error;
    if (scene === "POLICY" && (!policyGroup || !policyTarget)) {
      issue = "POLICY 场景需要填写策略组名称和目标策略";
      scene = "";
    }

    var changes = [];
    var policyError;
    if (state.policy && (scene !== "POLICY" || state.policy.group !== policyGroup ||
        state.policy.target !== policyTarget || network.mode !== MODES.RULE)) {
      try {
        if (restorePolicy()) changes.push("已恢复原策略");
      } catch (error) {
        policyError = error;
      }
      network = readNetwork();
      if (network.ssid !== ssid) return true;
    }

    if (scene === "POLICY") {
      if (state.mode) {
        network = restoreGlobal(network, true);
        if (network.ssid !== ssid) return true;
        changes.push("已恢复" + modeName(network.mode));
      }
      if (policyError) throw policyError;
      if (network.mode !== MODES.RULE) throw new Error("POLICY 场景仅在规则模式下切换策略组");
      if (applyPolicy()) {
        if (readNetwork().ssid !== ssid) return true;
        changes.push(policyGroup + " → " + policyTarget);
      }
    } else if (scene) {
      var applied = applyGlobal(network, MODES[scene]);
      if (applied) {
        if (applied.ssid !== ssid) return true;
        changes.push("已切换到" + modeName(applied.mode));
      }
    } else if (state.mode) {
      network = restoreGlobal(network, false);
      if (network.ssid !== ssid) return true;
      changes.push("已恢复" + modeName(network.mode));
    }

    if (policyError) throw policyError;
    if (issue) throw new Error(issue);
    clearLastError();
    if (changes.length || manualApply) {
      announce(changes.length ? changes.join(" · ") : "当前场景无需切换", ssid || "蜂窝网络/未连接 Wi-Fi");
    }
  }

  function pauseScene(network) {
    var ssid = network.ssid;
    // 先记录暂停，恢复设置触发的网络回调也会看到暂停状态。
    if (state.pausedSSID !== ssid) saveState({ pausedSSID: ssid });
    var policyError;
    if (state.policy) {
      try {
        restorePolicy();
      } catch (error) {
        policyError = error;
      }
      network = readNetwork();
    }
    if (state.mode && network.ssid === ssid) restoreGlobal(network, true);
    if (policyError) throw policyError;
    clearLastError();
    announce("当前 Wi-Fi 已暂停自动切换", ssid + " · 换网络或点「立即应用」可恢复");
  }

  function applyGlobal(network, target) {
    if (network.mode === target) return;
    var record;
    if (state.mode) {
      // 切换到第二个场景前先确认首次接管，保留最初的模式。
      settleMode(state.mode, network.mode);
      setMode(target);
    } else {
      record = { previous: network.mode, pending: target };
      takeOwnership("mode", record, function () { setMode(target); });
    }
    var observed = readNetwork();
    if (observed.mode === target) settleMode(record, observed.mode);
    else if (observed.ssid === network.ssid) throw new Error("切换后未读到" + modeName(target));
    return observed;
  }

  function settleMode(record, current) {
    if (!record || typeof record.pending === "undefined") return;
    var mode = current === record.pending ? { previous: record.previous } : null;
    saveState({ mode: mode }, "mode", record);
  }

  function restoreGlobal(network, usePrevious) {
    var record = state.mode;
    var target = restoreTarget(usePrevious);
    if (network.mode !== target) {
      setMode(target);
      var observed = readNetwork();
      if (observed.mode !== target) {
        if (observed.ssid !== network.ssid) return observed;
        throw new Error("恢复后运行模式又发生变化");
      }
      network = observed;
    }
    saveState({ mode: null }, "mode", record);
    return network;
  }

  function restoreTarget(usePrevious) {
    if (usePrevious || leaveMode === "PREVIOUS") return state.mode.previous;
    return leaveMode === "PROXY" ? MODES.PROXY : MODES.RULE;
  }

  function applyPolicy() {
    var current = selectedPolicy(policyGroup);
    if (current === policyTarget) return false;
    if (state.policy) {
      setPolicy(policyGroup, policyTarget);
    } else {
      takeOwnership("policy", { group: policyGroup, previous: current, target: policyTarget }, function () {
        setPolicy(policyGroup, policyTarget);
      });
    }
    if (selectedPolicy(policyGroup) !== policyTarget) {
      throw new Error("切换后策略组「" + policyGroup + "」未选中「" + policyTarget + "」");
    }
    return true;
  }

  function restorePolicy() {
    var policy = state.policy;
    var current = selectedPolicy(policy.group);
    // 当前值被用户改过时，保留用户的选择。
    if (current === policy.target) {
      setPolicy(policy.group, policy.previous);
      if (selectedPolicy(policy.group) !== policy.previous) {
        throw new Error("恢复后策略组「" + policy.group + "」的选择又发生变化");
      }
    }
    saveState({ policy: null }, "policy", policy);
    return current === policy.target;
  }

  function takeOwnership(key, record, change) {
    var update = {};
    update[key] = record;
    saveState(update);
    try {
      change();
    } catch (error) {
      update[key] = null;
      try {
        saveState(update, key, record);
      } catch (rollbackError) {
        throw new Error(message(error) + "，且" + message(rollbackError));
      }
      throw error;
    }
  }

  function setMode(mode) {
    if ($config.setRunningModel(mode) !== true) {
      throw new Error("无法切换到" + modeName(mode));
    }
  }

  function selectedPolicy(group) {
    var selected = $config.getSelectedPolicy(group);
    if (typeof selected !== "string" || !selected) {
      throw new Error("无法读取策略组「" + group + "」的当前选择");
    }
    return selected;
  }

  function setPolicy(group, target) {
    if ($config.setSelectPolicy(group, target) !== true) {
      throw new Error("无法把策略组「" + group + "」切换到「" + target + "」");
    }
  }

  function readBindings() {
    var result = Object.create(null);
    var raw = $persistentStore.read(BINDINGS_KEY);
    if (!raw) return result;
    var saved;
    try {
      saved = JSON.parse(raw);
    } catch (_) {
      console.log("[小羊网络场景] 已忽略损坏的策略组绑定记录");
    }
    Object.keys(saved || {}).forEach(function (ssid) {
      var entry = saved[ssid];
      if (entry && typeof entry.group === "string" && entry.group && typeof entry.target === "string" && entry.target) {
        result[ssid] = entry;
      }
    });
    return result;
  }

  function writeBindings(bindings) {
    if ($persistentStore.write(JSON.stringify(bindings), BINDINGS_KEY) !== true) {
      throw new Error("无法保存 Wi-Fi 的策略组绑定");
    }
  }

  function bindPolicy(ssid, bindings) {
    var environment = typeof $environment === "object" && $environment;
    var group = environment && environment.params && environment.params.policyGroup;
    if (typeof group !== "string" || !group) {
      throw new Error("请从 Loon 的策略组入口运行此操作，插件会读取该组已选中的策略");
    }
    var target = selectedPolicy(group);
    bindings[ssid] = { group: group, target: target };
    writeBindings(bindings);
    announce("已绑定到当前 Wi-Fi", ssid + " · " + group + " → " + target);
  }

  function readState() {
    var raw = $persistentStore.read(STORE_KEY);
    var saved;
    if (raw) {
      try {
        saved = JSON.parse(raw);
      } catch (_) {
        console.log("[小羊网络场景] 已忽略损坏的场景记录");
      }
    }
    saved = saved || {};

    var previous = saved.mode ? saved.mode.previous : saved.previousModel;
    var mode = (saved.mode || saved.active === true) && /^[012]$/.test(trim(previous))
      ? { previous: Number(previous) } : null;
    if (mode && saved.mode && /^[012]$/.test(trim(saved.mode.pending))) {
      mode.pending = Number(saved.mode.pending);
    }
    var policy = saved.policy;
    return {
      mode: mode,
      policy: policy && typeof policy.group === "string" && policy.group &&
        typeof policy.previous === "string" && policy.previous &&
        typeof policy.target === "string" && policy.target ? policy : null,
      pausedSSID: typeof saved.pausedSSID === "string" ? saved.pausedSSID : ""
    };
  }

  function saveState(patch, key, expected) {
    // 切换 API 可能触发另一轮脚本，合并最新记录以保留它取得的接管状态。
    var latest = readState();
    if (key && JSON.stringify(latest[key]) !== JSON.stringify(expected)) {
      state = latest;
      return;
    }
    var next = Object.assign({}, latest, patch);
    var encoded = JSON.stringify(next);
    if (encoded !== JSON.stringify(latest) && $persistentStore.write(encoded, STORE_KEY) !== true) {
      throw new Error("无法保存场景状态");
    }
    state = next;
  }

  function parseScenes() {
    var entries = Object.create(null);
    ssidList(args.trusted_ssids).forEach(function (ssid) {
      entries[ssid] = "DIRECT";
    });

    var explicit = trim(args.wifi_scenes).split(/[;；\r\n]+/);
    var seen = Object.create(null);
    for (var i = 0; i < explicit.length; i++) {
      var line = trim(explicit[i]);
      if (!line) continue;
      var separator = line.lastIndexOf("=");
      var name = separator > 0 ? trim(line.slice(0, separator)) : "";
      var scene = trim(line.slice(separator + 1)).toUpperCase();
      if (!name || (scene !== "POLICY" && !Object.prototype.hasOwnProperty.call(MODES, scene))) {
        return { entries: entries, error: "Wi-Fi 场景第 " + (i + 1) + " 项需填写 SSID=DIRECT/RULE/PROXY/POLICY" };
      }
      if (seen[name]) return { entries: entries, error: "Wi-Fi 场景重复设置了「" + name + "」" };
      seen[name] = true;
      entries[name] = scene;
    }
    var ruleSSIDs = ssidList(args.rule_ssids);
    var proxySSIDs = ssidList(args.proxy_ssids);
    var duplicate = ruleSSIDs.find(function (ssid) { return proxySSIDs.indexOf(ssid) !== -1; });
    if (duplicate) return { entries: entries, error: "「" + duplicate + "」同时填在规则模式和全局代理列表" };
    ruleSSIDs.forEach(function (ssid) { entries[ssid] = "RULE"; });
    proxySSIDs.forEach(function (ssid) { entries[ssid] = "PROXY"; });
    return { entries: entries, error: "" };
  }

  function ssidList(value) {
    return trim(value).split(/[,，;；\r\n]+/).map(trim).filter(Boolean);
  }

  function showStatus(ssid, currentMode, scene) {
    var paused = state.pausedSSID && ssid === state.pausedSSID;
    var pending = state.mode && typeof state.mode.pending !== "undefined";
    var details = [
      "当前模式：" + modeName(currentMode),
      "匹配场景：" + (scene === "POLICY" ? "策略组" : (scene ? modeName(MODES[scene]) : "无")),
      "自动切换：" + (pauseAll ? "设置开关已暂停" :
        (paused ? "当前 Wi-Fi 已暂停" : (state.pausedSSID && !ssid ? "等待确认是否已离开暂停的 Wi-Fi" : "启用"))),
      "插件接管：" + ([state.mode ? (pending ? "运行模式待确认" : "运行模式") : "",
        state.policy ? "策略组" : ""].filter(Boolean).join("、") || "无")
    ];
    if (state.mode) {
      details.push("离开后恢复：" + modeName(restoreTarget(false)));
    }
    if (state.policy || scene === "POLICY") {
      var group = state.policy ? state.policy.group : policyGroup;
      if (group) {
        var current = $config.getSelectedPolicy(group);
        details.push("策略组：" + group + " / 当前：" + (current || "未找到") + " / 目标：" +
          (state.policy ? state.policy.target : (policyTarget || "未填写")));
        if (state.policy) details.push("原策略：" + state.policy.previous);
      } else {
        details.push("策略组：未填写");
      }
    }
    if (scenes.error) details.push("配置错误：" + scenes.error);
    if (scene === "POLICY" && (!policyGroup || !policyTarget)) {
      details.push("POLICY 场景需要填写策略组名称和目标策略");
    } else if (scene === "POLICY" && (state.mode ? state.mode.previous : currentMode) !== MODES.RULE) {
      details.push("POLICY 场景仅在规则模式下切换策略组");
    }
    var lastError = $persistentStore.read(ERROR_KEY);
    if (lastError && lastError !== scenes.error) details.push("最近错误：" + lastError);
    announce(ssid || "蜂窝网络/未连接 Wi-Fi", details.join("\n"));
  }

  function clearLastError() {
    if ($persistentStore.read(ERROR_KEY)) $persistentStore.write(null, ERROR_KEY);
  }

  function reportError(error) {
    var detail = message(error);
    console.log("[小羊网络场景] " + detail);
    if (status) {
      announce("读取场景失败", detail);
      return;
    }
    try {
      if ($persistentStore.read(ERROR_KEY) === detail) {
        if (!manual) return;
      } else {
        $persistentStore.write(detail, ERROR_KEY);
      }
    } catch (_) {
      // 存储异常时仍反馈本次错误。
    }
    announce("应用场景失败", detail);
  }

  function announce(title, detail) {
    if (notifications || manual) $notification.post("小羊网络场景", title, detail);
  }

  function modeName(mode) {
    return ["全局直连", "规则模式", "全局代理"][mode] || "未知模式";
  }

  function trim(value) {
    return value === null || typeof value === "undefined" ? "" : String(value).trim();
  }

  function message(error) {
    return trim(error && error.message ? error.message : error).replace(/[\r\n]+/g, " ").slice(0, 180);
  }
})();
