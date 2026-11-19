'use strict';
// Общие модули расчётов: в Electron отдаются по протоколу econ:, в браузере — dev-сервером.
// В тестах EC/RP могут быть уже загружены вручную — тогда document.write не нужен.
if (!window.EC || !window.RP) {
  document.write('<script src="' + (window.wbApp ? 'econ:///economics.js?v=workspace-boost-v4' : '/economics.js?v=workspace-boost-v4') + '"><\/script>');
  document.write('<script src="' + (window.wbApp ? 'econ:///repricer-engine.js?v=workspace-boost-v4' : '/repricer-engine.js?v=workspace-boost-v4') + '"><\/script>');
}
