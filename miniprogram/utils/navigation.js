'use strict';

/**
 * 进入房间页。navigateTo 在页面栈满等情况下会失败，使用 redirectTo 兜底，
 * 两者都失败时把微信原始错误带回调用方，避免点击后静默无响应。
 */
function navigateToRoom(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(normalized)) {
    return Promise.reject(Object.assign(new Error('服务端返回的邀请码无效'), { code: 'BAD_ROOM_RESPONSE' }));
  }
  const url = `/pages/room/room?code=${normalized}`;
  return new Promise((resolve, reject) => {
    wx.navigateTo({
      url,
      success: resolve,
      fail(navError) {
        console.warn('[navigation] navigateTo 失败，尝试 redirectTo', navError);
        wx.redirectTo({
          url,
          success: resolve,
          fail(redirectError) {
            const detail = redirectError && redirectError.errMsg ? redirectError.errMsg : 'unknown error';
            reject(Object.assign(new Error(`进入房间页面失败：${detail}`), {
              code: 'NAVIGATION_FAILED',
              cause: redirectError,
            }));
          },
        });
      },
    });
  });
}

module.exports = { navigateToRoom };
