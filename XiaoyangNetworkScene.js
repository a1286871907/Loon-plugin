/*
 * 小羊网络场景 for Loon 3.5.1 (986)
 * 可信 Wi-Fi => 全局直连；其他 Wi-Fi/蜂窝 => 规则模式。
 */

(function () {
  "use strict";

  var STORE_KEY = "xiaoyang.network.scene.state";
  var args = typeof $argument === "object" && $argument ? $argument : {};
  var trusted = parseSSIDList(args.trusted_ssids);
  var manual = typeof $environment !== "undefined";

  console.log(
    "[小羊网络场景] v1.0.1 已加载；可信 Wi-Fi 数量：" + trusted.length +
    "；触发方式：" + (manual ? "手动" : "网络变化")
  );

  if (!trusted.length) {
    notify("配置未生效", "请至少填写一个 Wi-Fi 名称");
    $done();
    return;
  }

  // 直接执行，避免部分 NETWORK-CHANGED 运行环境提前释放延迟回调。
  applyScene();

  function applyScene() {
    var config;
    try {
      config = JSON.parse($config.getConfig());
    } catch (error) {
      notify("读取网络失败", safeMessage(error));
      $done();
      return;
    }

    var ssid = normalize(config.ssid);
    var isTrusted = ssid !== "" && trusted.indexOf(ssid) !== -1;
    var currentModel = Number(config.running_model);
    var networkName = ssid || "蜂窝网络/未连接 Wi-Fi";
    var state = readState();

    // 不在可信 Wi-Fi，且此前并非本插件切到直连：完全不接管用户当前模式。
    if (!isTrusted && !state.active) {
      console.log("[小羊网络场景] 当前不属于可信 Wi-Fi，插件未接管，保持现有模式");
      if (manual) {
        notify("无需切换", networkName + " · 保持" + modeName(currentModel));
      }
      $done();
      return;
    }

    var targetModel = isTrusted ? 0 : 1;

    console.log(
      "[小羊网络场景] 当前：" + networkName +
      "；目标：" + modeName(targetModel) +
      "；当前模式：" + modeName(currentModel)
    );

    if (currentModel === targetModel) {
      writeState(isTrusted, isTrusted ? ssid : "");
      if (manual) {
        notify("当前模式正确", networkName + " · " + modeName(targetModel));
      }
      $done();
      return;
    }

    try {
      $config.setRunningModel(targetModel);
      writeState(isTrusted, isTrusted ? ssid : "");

      if (isTrusted) {
        notify("已进入直连场景", ssid + " · 所有流量全局直连");
      } else {
        notify("已恢复规则模式", networkName + " · 原有规则和策略组保持不变");
      }
    } catch (error) {
      notify("切换模式失败", safeMessage(error));
    }

    $done();
  }

  function readState() {
    var raw = $persistentStore.read(STORE_KEY);
    if (!raw) return { active: false, ssid: "" };
    try {
      var value = JSON.parse(raw);
      return {
        active: value && value.active === true,
        ssid: value && value.ssid ? String(value.ssid) : ""
      };
    } catch (_) {
      return { active: false, ssid: "" };
    }
  }

  function writeState(active, ssid) {
    $persistentStore.write(JSON.stringify({ active: active, ssid: ssid }), STORE_KEY);
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

  function notify(subtitle, content) {
    $notification.post("小羊网络场景", subtitle, content);
  }

  function safeMessage(error) {
    var message = error && error.message ? error.message : String(error || "未知错误");
    return message.replace(/[\r\n]+/g, " ").slice(0, 160);
  }
})();
