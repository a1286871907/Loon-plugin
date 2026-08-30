/*
 * 小羊网络场景 for Loon 3.5.1 (986)
 * 可信 Wi-Fi => 全局直连；其他 Wi-Fi/蜂窝 => 规则模式。
 */

(function () {
  "use strict";

  var STORE_KEY = "xiaoyang.network.scene.state";
  var args = typeof $argument === "object" && $argument ? $argument : {};
  var trusted = parseSSIDList(args.trusted_ssids);
  var leaveMode = normalizeLeaveMode(args.leave_mode);
  var notificationsEnabled = booleanValue(args.notifications, true);
  var emptySSIDGraceMS = boundedNumber(args.empty_grace_ms, 800, 200, 3000);
  var selfEventWindowMS = 3000;
  var manual = typeof $environment !== "undefined";

  console.log(
    "[小羊网络场景] v1.2.0 已加载；可信 Wi-Fi 数量：" + trusted.length +
    "；触发方式：" + (manual ? "手动" : "网络变化")
  );

  if (!trusted.length) {
    notify("配置未生效", "请至少填写一个 Wi-Fi 名称");
    $done();
    return;
  }

  applyScene(false);

  function applyScene(emptySSIDChecked) {
    var config = readConfig();
    if (!config) return;

    var ssid = normalize(config.ssid);
    var isTrusted = ssid !== "" && trusted.indexOf(ssid) !== -1;
    var currentModel = Number(config.running_model);
    var networkName = ssid || "蜂窝网络/未连接 Wi-Fi";
    var state = readState();

    if (consumeSelfGeneratedEvent(state, currentModel, ssid, isTrusted)) {
      $done();
      return;
    }

    // 模式重载时 Loon 可能短暂返回空 SSID。只对空值做一次 800ms 稳定化读取；
    // 明确的其他 Wi-Fi 仍立即恢复，不存在全局冷却或切换频率限制。
    if (ssid === "" && state.active && !emptySSIDChecked) {
      console.log("[小羊网络场景] SSID 暂时为空，" + emptySSIDGraceMS + "ms 后仅重读一次网络状态");
      setTimeout(function () {
        applyScene(true);
      }, emptySSIDGraceMS);
      return;
    }

    // 不在可信 Wi-Fi，且此前并非本插件切到直连：完全不接管用户当前模式。
    if (!isTrusted && !state.active) {
      console.log("[小羊网络场景] 当前不属于可信 Wi-Fi，插件未接管，保持现有模式");
      if (manual) {
        notify("无需切换", networkName + " · 保持" + modeName(currentModel));
      }
      $done();
      return;
    }

    var targetModel = isTrusted ? 0 : restoreModel(state);
    var previousModel = isTrusted
      ? (state.active ? state.previousModel : safePreviousModel(currentModel))
      : 1;

    console.log(
      "[小羊网络场景] 当前：" + networkName +
      "；目标：" + modeName(targetModel) +
      "；当前模式：" + modeName(currentModel)
    );

    if (currentModel === targetModel) {
      writeState({
        active: isTrusted,
        ssid: isTrusted ? ssid : "",
        previousModel: previousModel
      });
      if (manual) {
        notify("当前模式正确", networkName + " · " + modeName(targetModel));
      }
      $done();
      return;
    }

    try {
      // 必须先写一次性标记，再切换模式；这样由 setRunningModel 自身产生的
      // 下一次 NETWORK-CHANGED 回调不会反向触发另一次模式切换。
      writeState({
        active: isTrusted,
        ssid: isTrusted ? ssid : "",
        previousModel: previousModel,
        ignoreModel: targetModel,
        ignoreUntil: Date.now() + selfEventWindowMS
      });
      $config.setRunningModel(targetModel);

      if (isTrusted) {
        announce("已进入直连场景", ssid + " · 所有流量全局直连");
      } else {
        announce("已恢复" + modeName(targetModel), networkName + " · 原有规则和策略选择未修改");
      }
    } catch (error) {
      notify("切换模式失败", safeMessage(error));
    }

    $done();
  }

  function readConfig() {
    try {
      return JSON.parse($config.getConfig());
    } catch (error) {
      notify("读取网络失败", safeMessage(error));
      $done();
      return null;
    }
  }

  function consumeSelfGeneratedEvent(state, currentModel, ssid, isTrusted) {
    var markerValid =
      state.ignoreUntil > 0 &&
      Date.now() <= state.ignoreUntil &&
      currentModel === state.ignoreModel;

    if (!markerValid) return false;

    var sameTrustedScene = state.active && isTrusted && ssid === state.ssid;
    var sameRestoredScene = !state.active && !isTrusted;
    if (ssid !== "" && !sameTrustedScene && !sameRestoredScene) {
      // 标记有效期间恰好发生了真实网络变化，不能吞掉。
      writeState({
        active: state.active,
        ssid: state.ssid,
        previousModel: state.previousModel
      });
      return false;
    }

    writeState({
      active: state.active,
      ssid: state.ssid,
      previousModel: state.previousModel
    });
    console.log("[小羊网络场景] 已忽略自身模式切换产生的网络变化");
    return true;
  }

  function readState() {
    var raw = $persistentStore.read(STORE_KEY);
    if (!raw) return emptyState();
    try {
      var value = JSON.parse(raw);
      return {
        active: value && value.active === true,
        ssid: value && value.ssid ? String(value.ssid) : "",
        previousModel: value && (Number(value.previousModel) === 1 || Number(value.previousModel) === 2)
          ? Number(value.previousModel)
          : 1,
        ignoreModel: value && typeof value.ignoreModel !== "undefined" ? Number(value.ignoreModel) : -1,
        ignoreUntil: value && value.ignoreUntil ? Number(value.ignoreUntil) : 0
      };
    } catch (_) {
      return emptyState();
    }
  }

  function emptyState() {
    return { active: false, ssid: "", previousModel: 1, ignoreModel: -1, ignoreUntil: 0 };
  }

  function writeState(value) {
    $persistentStore.write(JSON.stringify({
      active: value.active === true,
      ssid: value.ssid ? String(value.ssid) : "",
      previousModel: Number(value.previousModel) === 2 ? 2 : 1,
      ignoreModel: typeof value.ignoreModel !== "undefined" ? Number(value.ignoreModel) : -1,
      ignoreUntil: value.ignoreUntil ? Number(value.ignoreUntil) : 0
    }), STORE_KEY);
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

  function restoreModel(state) {
    if (leaveMode === "PROXY") return 2;
    if (leaveMode === "PREVIOUS") return safePreviousModel(state.previousModel);
    return 1;
  }

  function safePreviousModel(model) {
    return Number(model) === 2 ? 2 : 1;
  }

  function normalizeLeaveMode(value) {
    var mode = normalize(value).toUpperCase();
    return mode === "PROXY" || mode === "PREVIOUS" ? mode : "RULE";
  }

  function booleanValue(value, fallback) {
    if (value === true || value === "true" || value === 1 || value === "1") return true;
    if (value === false || value === "false" || value === 0 || value === "0") return false;
    return fallback;
  }

  function boundedNumber(value, fallback, minimum, maximum) {
    var number = Number(value);
    if (!isFinite(number)) return fallback;
    return Math.max(minimum, Math.min(maximum, Math.round(number)));
  }

  function announce(subtitle, content) {
    if (notificationsEnabled || manual) notify(subtitle, content);
  }

  function notify(subtitle, content) {
    $notification.post("小羊网络场景", subtitle, content);
  }

  function safeMessage(error) {
    var message = error && error.message ? error.message : String(error || "未知错误");
    return message.replace(/[\r\n]+/g, " ").slice(0, 160);
  }
})();
