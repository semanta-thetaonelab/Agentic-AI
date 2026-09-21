// Thin wrapper around robotjs so index.js stays focused on the agent loop.
const robot = require('robotjs');

robot.setMouseDelay(20);
robot.setKeyboardDelay(20);

function moveMouse(x, y) {
  robot.moveMouseSmooth(x, y);
  return { status: 'ok', x, y };
}

function clickMouse(button = 'left', double = false) {
  robot.mouseClick(button, double);
  return { status: 'ok', button, double };
}

function typeText(text) {
  robot.typeString(text);
  return { status: 'ok', text };
}

function pressKey(key, modifiers = []) {
  if (modifiers.length > 0) {
    robot.keyTap(key, modifiers);
  } else {
    robot.keyTap(key);
  }
  return { status: 'ok', key, modifiers };
}

function scroll(x, y) {
  robot.scrollMouse(x, y);
  return { status: 'ok', x, y };
}

function getScreenSize() {
  return robot.getScreenSize();
}

function getMousePosition() {
  return robot.getMousePos();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  moveMouse,
  clickMouse,
  typeText,
  pressKey,
  scroll,
  getScreenSize,
  getMousePosition,
  wait
};