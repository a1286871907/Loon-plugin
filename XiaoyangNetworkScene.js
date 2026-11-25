/*
 * 小羊网络场景 for Loon 3.5.1 (986)
 * 可信 Wi-Fi => 全局直连；离开已接管的场景后按设置恢复。
 */

(function () {
  "use strict";

  var STORE_KEY = "xiaoyang.network.scene.state";
  var EMPTY_SSID_GRACE_MS = 800;
  var args = typeof $argument === "object" && $argument ? $argument : {};
  var trusted = parseSSIDList(args.trusted_ssids);
  var leaveMode = parseLeaveMode(args.leave_mode);
  var showNotifications = parseBoolean(args.notifications, true);
  var emptySSIDGraceMS = parseDelay(args.empty_grace_ms);
  var manual = typeof $script !== "undefined" && $script.name === "立即应用当前网络场景";

  console.log(
    "[小羊网络场景] v1.2.3 已加载；可信 Wi-Fi 数量：" + trusted.length +
    "；触发方式：" + (manual ? "手动" : "网络变化")
  );

  applyScene(false);

  function applyScene(emptySSIDChecked) {
    try {
      var config = JSON.parse($config.getConfig());
      var rawModel = normalize(config && config.running_model);
      if (!/^[012]$/.test(rawModel)) {
        throw new Error("无法读取当前运行模式");
      }

      var currentModel = Number(rawModel);
      var ssid = normalize(config.ssid);
      var isTrusted = ssid !== "" && trusted.indexOf(ssid) !== -1;
      var networkName = ssid || "蜂窝网络/未连接 Wi-Fi";
      var state = readState();

      // 模式重载和真实离开 Wi-Fi 都可能返回空 SSID，延迟一次后重新读取状态。
      if (ssid === "" && trusted.length && state.active && !emptySSIDChecked) {
        console.log("[小羊网络场景] SSID 暂时为空，" + emptySSIDGraceMS + "ms 后重读网络状态");
        setTimeout(function () {
          applyScene(true);
        }, emptySSIDGraceMS);
        return;
      }

      if (isTrusted) {
        enterScene(state, currentModel, ssid);
      } else if (state.active) {
        leaveScene(state, currentModel, networkName);
      } else if (manual) {
        if (trusted.length) notify("无需切换", networkName + " · 保持" + modeName(currentModel));
        else notify("配置未生效", "请至少填写一个 Wi-Fi 名称");
      }
    } catch (error) {
      var message = safeMessage(error);
      console.log("[小羊网络场景] 应用场景失败：" + message);
      announce("应用场景失败", message);
    }

    $done();
  }

  function enterScene(state, currentModel, ssid) {
    if (currentModel === 0) {
      if (manual) notify("当前模式正确", ssid + " · 全局直连");
      return;
    }

    if (state.active) {
      setModel(0);
    } else {
      // 切到直连前先保存原模式，网络回调和下次启动才能执行恢复。
      writeState({ active: true, previousModel: currentModel });
      try {
        setModel(0);
      } catch (error) {
        try {
          writeState(state);
        } catch (rollbackError) {
          throw new Error(safeMessage(error) + "，且" + safeMessage(rollbackError));
        }
        throw error;
      }
    }
    announce("已进入直连场景", ssid + " · 全局直连");
  }

  function leaveScene(state, currentModel, networkName) {
    var targetModel = restoreModel(state.previousModel);
    if (currentModel !== targetModel) setModel(targetModel);
    writeState({ active: false });
    announce("已恢复" + modeName(targetModel), networkName + " · " + modeName(targetModel));
  }

  function setModel(model) {
    if ($config.setRunningModel(model) !== true) {
      throw new Error("无法切换到" + modeName(model));
    }
  }

  function readState() {
    var raw = $persistentStore.read(STORE_KEY);
    if (raw) {
      try {
        var value = JSON.parse(raw);
        if (value && value.active === true) {
          return { active: true, previousModel: Number(value.previousModel) === 2 ? 2 : 1 };
        }
      } catch (_) {
        // 损坏的记录按未接管处理。
      }
    }
    return { active: false };
  }

  function writeState(value) {
    if ($persistentStore.write(JSON.stringify(value), STORE_KEY) !== true) {
      throw new Error("无法保存场景状态");
    }
  }

  function parseSSIDList(value) {
    var text = value === null || typeof value === "undefined" ? "" : String(value);
    var parts = text.split(/[,，;；\n\r]+/);
    var result = [];

    parts.forEach(function (item) {
      var name = normalize(item);
      if (name && result.indexOf(name) === -1) result.push(name);
    });

    return result;
  }

  function normalize(value) {
    return value === null || typeof value === "undefined" ? "" : String(value).trim();
  }

  function modeName(model) {
    if (Number(model) === 0) return "全局直连";
    if (Number(model) === 1) return "规则模式";
    if (Number(model) === 2) return "全局代理";
    return "未知模式";
  }

  function restoreModel(previousModel) {
    if (leaveMode === "PROXY") return 2;
    if (leaveMode === "PREVIOUS") return Number(previousModel) === 2 ? 2 : 1;
    return 1;
  }

  function parseLeaveMode(value) {
    var mode = normalize(value).toUpperCase();
    return mode === "PROXY" || mode === "PREVIOUS" ? mode : "RULE";
  }

  function parseBoolean(value, fallback) {
    if (value === true || value === "true") return true;
    if (value === false || value === "false") return false;
    return fallback;
  }

  function parseDelay(value) {
    var delay = Number(value);
    return isFinite(delay) && delay >= 200 && delay <= 3000 ? Math.round(delay) : EMPTY_SSID_GRACE_MS;
  }

  function announce(subtitle, content) {
    if (showNotifications || manual) notify(subtitle, content);
  }

  function notify(subtitle, content) {
    $notification.post("小羊网络场景", subtitle, content);
  }

  function safeMessage(error) {
    var message = error && error.message ? error.message : String(error || "未知错误");
    return message.replace(/[\r\n]+/g, " ").slice(0, 160);
  }
})();
