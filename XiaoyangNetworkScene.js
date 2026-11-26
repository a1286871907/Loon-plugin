/* 小羊网络场景 v2.2.0 for Loon 3.5.1 (986) */
(function () {
  "use strict";

  var STORE_KEY = "xiaoyang.network.scene.state";
  var ERROR_KEY = "xiaoyang.network.scene.last_error";
  var EMPTY_SSID_WAIT = 800;
  var args = typeof $argument === "object" && $argument ? $argument : {};
  var tag = typeof $script === "object" && $script ? $script.name : "";
  var apply = tag === "立即应用当前网络场景";
  var toggle = tag === "暂停或恢复当前 Wi-Fi";
  var status = tag === "查看当前网络场景";
  var manual = apply || toggle || status;
  var paused = args.pause_auto === true || args.pause_auto === "true";
  var notifications = args.notifications !== false && args.notifications !== "false";
  var leaveMode = args.leave_mode;
  var scenes = readScenes();
  var state;
  var actionSSID;
  var actionHandled = false;

  run(false);

  function run(rechecked) {
    var waiting = false;
    try {
      if (tag && !manual && tag !== "小羊网络场景") return;
      if (paused && !status) {
        if (manual) {
          announce("自动切换已暂停", "在插件设置关闭「暂停自动切换」后即可继续");
        } else {
          state = readState();
          if (state.pausedSSID) {
            var pausedNetwork = readNetwork();
            if (!pausedNetwork.ssid && !rechecked) waiting = recheck();
            else if (pausedNetwork.ssid !== state.pausedSSID) {
              saveState({ pausedSSID: "" }, "pausedSSID", state.pausedSSID);
            }
          }
        }
        return;
      }

      var network = readNetwork();
      state = readState();

      if (status) {
        showStatus(network);
        return;
      }
      if (!network.ssid && !rechecked && (state.mode || state.pausedSSID || manual || Object.keys(scenes).length)) {
        waiting = recheck();
        return;
      }

      var migrationError;
      if (state.policy && (manual || !network.ssid || state.pausedSSID !== network.ssid)) {
        try {
          restoreOldPolicy();
        } catch (error) {
          migrationError = error;
        }
        var observed = readNetwork();
        if (observed.ssid !== network.ssid) {
          if (!rechecked) waiting = recheck();
          return;
        }
        network = observed;
      }

      var owned = effectiveMode(network.mode);
      if (state.mode && !owned) saveState({ mode: null }, "mode", state.mode);
      if (manual && typeof actionSSID === "undefined") actionSSID = network.ssid;

      if (updateScene(network, owned) && !rechecked) waiting = recheck();
      if (migrationError) throw migrationError;
      if (!waiting && (!state.pausedSSID || (toggle && actionHandled))) clearError();
    } catch (error) {
      reportError(error);
    } finally {
      if (!waiting) $done();
    }
  }

  function recheck() {
    setTimeout(function () { run(true); }, EMPTY_SSID_WAIT);
    return true;
  }

  function readNetwork() {
    var config = JSON.parse($config.getConfig());
    var mode = parseMode(config && config.running_model);
    if (mode === undefined) throw new Error("无法读取当前运行模式");
    return { ssid: trim(config.ssid), mode: mode };
  }

  function updateScene(network, owned) {
    var ssid = network.ssid;
    var samePause = !!ssid && state.pausedSSID === ssid;
    var manualHere = (apply || toggle) && !actionHandled && actionSSID === ssid;
    if (manualHere) actionHandled = true;
    if (toggle && manualHere && !ssid) throw new Error("先连上 Wi-Fi，再暂停当前网络");

    if (toggle && manualHere && !samePause) {
      saveState({ pausedSSID: ssid });
      if (owned && restoreMode(network, owned.previous).ssid !== ssid) return true;
      announce("已暂停当前 Wi-Fi", ssid + " · 再执行一次即可恢复，换网络后也会自动解除");
      return false;
    }

    if (state.pausedSSID) {
      if (samePause && !manualHere) return false;
      saveState({ pausedSSID: "" });
    }

    var target = scenes[ssid];
    var changed;
    if (target >= 0) {
      if (network.mode !== target) {
        changed = switchMode(network, target, owned);
        if (changed.ssid !== ssid) return true;
        announce("已切换到" + modeName(changed.mode), ssid);
      }
    } else if (owned) {
      changed = restoreMode(network, restoreTarget(owned));
      if (changed.ssid !== ssid) return true;
      announce("已恢复" + modeName(changed.mode), ssid || "没有连接 Wi-Fi");
    }

    if (target === -1) throw new Error("「" + ssid + "」填在多个模式名单中，请只保留一处");
    if (manualHere && !changed) {
      announce(samePause ? "已恢复当前 Wi-Fi 的自动切换" : "当前模式无需切换", modeName(network.mode));
    }
    return false;
  }

  function switchMode(network, target, owned) {
    var previousRecord = state.mode;
    var previous = owned ? owned.previous : network.mode;
    var record = { previous: previous, applied: owned ? network.mode : undefined, pending: target };
    saveState({ mode: record });
    try {
      setMode(target);
    } catch (error) {
      try {
        saveState({ mode: previousRecord }, "mode", record);
      } catch (rollbackError) {
        throw new Error(message(error) + "；" + message(rollbackError));
      }
      throw error;
    }
    var observed = readNetwork();
    if (observed.mode === target) {
      saveState({ mode: { previous: previous, applied: target } }, "mode", record);
    } else if (observed.ssid === network.ssid) {
      throw new Error("切换后未读到" + modeName(target));
    }
    return observed;
  }

  function restoreMode(network, target) {
    var record = state.mode;
    if (network.mode !== target) {
      setMode(target);
      var observed = readNetwork();
      if (observed.mode !== target) {
        if (observed.ssid !== network.ssid) return observed;
        throw new Error("恢复后未读到" + modeName(target));
      }
      network = observed;
    }
    saveState({ mode: null }, "mode", record);
    return network;
  }

  function effectiveMode(current) {
    var record = state.mode;
    if (!record) return null;
    // 有读回证据才视为接管，手动选的新模式继续归用户控制。
    if (record.pending === current || record.applied === current) return record;
    return record.pending === undefined && record.applied === undefined ? record : null;
  }

  function restoreTarget(owned) {
    if (leaveMode === "PREVIOUS") return owned.previous;
    return leaveMode === "PROXY" ? 2 : 1;
  }

  function setMode(mode) {
    if ($config.setRunningModel(mode) !== true) throw new Error("无法切换到" + modeName(mode));
  }

  // 只清理旧版接管中留下的记录。从未启用该功能的设备不会调用策略组 API。
  function restoreOldPolicy() {
    var record = state.policy;
    var current = $config.getSelectedPolicy(record.group);
    if (current === record.target &&
        ($config.setSelectPolicy(record.group, record.previous) !== true ||
         $config.getSelectedPolicy(record.group) !== record.previous)) {
      throw new Error("无法还原旧版改动的策略组「" + record.group + "」");
    }
    saveState({ policy: null }, "policy", record);
  }

  function readState() {
    var raw = $persistentStore.read(STORE_KEY);
    var saved = {};
    try {
      if (raw) saved = JSON.parse(raw) || {};
    } catch (_) {
      console.log("[小羊网络场景] 已忽略损坏的场景记录");
    }

    var previous = parseMode(saved.mode ? saved.mode.previous : saved.previousModel);
    var mode = null;
    if (previous !== undefined && (saved.mode || saved.active === true)) {
      mode = { previous: previous };
      if (saved.mode) {
        var applied = parseMode(saved.mode.applied);
        var pending = parseMode(saved.mode.pending);
        if (applied !== undefined) mode.applied = applied;
        if (pending !== undefined) mode.pending = pending;
      } else {
        mode.applied = 0;
      }
    }
    var policy = saved.policy;
    return {
      mode: mode,
      pausedSSID: typeof saved.pausedSSID === "string" ? saved.pausedSSID : "",
      policy: policy && typeof policy.group === "string" && policy.group &&
        typeof policy.previous === "string" && policy.previous &&
        typeof policy.target === "string" && policy.target ? policy : null
    };
  }

  function saveState(patch, key, expected) {
    // 设置模式可能触发另一轮脚本，只清除当前执行开始时持有的记录。
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

  function readScenes() {
    var entries = Object.create(null);
    [args.trusted_ssids, args.rule_ssids, args.proxy_ssids].forEach(function (list, mode) {
      trim(list).split(/[,，;；\r\n]+/).map(trim).filter(Boolean).forEach(function (ssid) {
        entries[ssid] = entries[ssid] === undefined || entries[ssid] === mode ? mode : -1;
      });
    });
    return entries;
  }

  function showStatus(network) {
    var ssid = network.ssid;
    var target = scenes[ssid];
    var owned = effectiveMode(network.mode);
    var details = [
      "当前模式：" + modeName(network.mode),
      "此 Wi-Fi 场景：" + (target === -1 ? "名单重复，请只保留一处" : (target === undefined ? "未设置" : modeName(target))),
      "自动切换：" + (paused ? "已在设置中暂停" :
        (state.pausedSSID && ssid === state.pausedSSID ? "当前 Wi-Fi 已暂停" : "开启")),
      "离开后：" + (owned && !paused ? "恢复" + modeName(restoreTarget(owned)) : "保持当前模式")
    ];
    var error = $persistentStore.read(ERROR_KEY);
    if (error) details.push("最近错误：" + error);
    announce(ssid || "没有连接 Wi-Fi", details.join("\n"));
  }

  function clearError() {
    if ($persistentStore.read(ERROR_KEY)) $persistentStore.write(null, ERROR_KEY);
  }

  function reportError(error) {
    var detail = message(error);
    console.log("[小羊网络场景] " + detail);
    if (!status) {
      try {
        if ($persistentStore.read(ERROR_KEY) === detail) {
          if (!manual) return;
        } else {
          $persistentStore.write(detail, ERROR_KEY);
        }
      } catch (_) {
        // 状态不可写时仍提示这次错误。
      }
    }
    announce(status ? "读取场景失败" : "应用场景失败", detail);
  }

  function announce(title, detail) {
    if (manual || notifications) $notification.post("小羊网络场景", title, detail);
  }

  function modeName(mode) {
    return ["全局直连", "规则模式", "全局代理"][mode];
  }

  function parseMode(value) {
    var text = trim(value);
    if (/^[012]$/.test(text)) return Number(text);
  }

  function trim(value) {
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function message(error) {
    return trim(error && error.message ? error.message : error).replace(/[\r\n]+/g, " ").slice(0, 180);
  }
})();
