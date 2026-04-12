(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.AdminProofViewer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeRotation(deg) {
    return ((Number(deg || 0) % 360) + 360) % 360;
  }

  function isSideways(deg) {
    const normalized = normalizeRotation(deg);
    return normalized === 90 || normalized === 270;
  }

  function createProofViewer(refs) {
    const overlay = refs.overlay;
    const stage = refs.stage;
    const actions = refs.actions;
    const image = refs.image;
    const error = refs.error;

    let rotateDeg = 0;
    let positionTimer = 0;

    function getActionTarget() {
      if (image.style.display !== 'none' && image.getBoundingClientRect().width > 0) return image;
      if (error.style.display !== 'none' && error.getBoundingClientRect().width > 0) return error;
      return null;
    }

    function positionActions() {
      if (!overlay.classList.contains('show')) {
        actions.style.visibility = 'hidden';
        stage.style.width = '';
        stage.style.height = '';
        return;
      }

      const target = getActionTarget();
      if (!target) {
        actions.style.visibility = 'hidden';
        stage.style.width = '';
        stage.style.height = '';
        return;
      }

      const rect = target.getBoundingClientRect();
      stage.style.width = `${Math.ceil(rect.width)}px`;
      stage.style.height = `${Math.ceil(rect.height)}px`;
      actions.style.visibility = 'visible';
    }

    function scheduleActionsPosition() {
      window.clearTimeout(positionTimer);
      positionActions();
      requestAnimationFrame(() => {
        positionActions();
        requestAnimationFrame(positionActions);
      });
      positionTimer = window.setTimeout(positionActions, 300);
    }

    function applyRotation() {
      image.style.transform = `rotate(${rotateDeg}deg)`;
      image.style.maxWidth = isSideways(rotateDeg) ? '78vh' : '100%';
      image.style.maxHeight = isSideways(rotateDeg) ? '92vw' : '78vh';
      scheduleActionsPosition();
    }

    function handleLoad() {
      error.style.display = 'none';
      image.style.display = '';
      rotateDeg = 0;
      applyRotation();
    }

    function handleError() {
      image.style.display = 'none';
      error.style.display = 'block';
      scheduleActionsPosition();
    }

    function open(src) {
      if (!src) return;
      stage.style.width = '';
      stage.style.height = '';
      actions.style.visibility = 'hidden';
      error.style.display = 'none';
      rotateDeg = 0;
      image.style.display = '';
      image.style.transform = '';
      image.style.maxWidth = '100%';
      image.style.maxHeight = '78vh';
      image.src = src;
      overlay.classList.add('show');
      scheduleActionsPosition();
    }

    function close() {
      overlay.classList.remove('show');
      window.clearTimeout(positionTimer);
      stage.style.width = '';
      stage.style.height = '';
      actions.style.visibility = 'hidden';
      image.src = '';
      image.style.transform = '';
    }

    function rotate() {
      if (!image.src) return;
      rotateDeg += 90;
      applyRotation();
    }

    function handleOverlay(event) {
      if (event.target === overlay) close();
    }

    function handleKeydown(event) {
      if (event.key === 'Escape' && overlay.classList.contains('show')) {
        close();
      }
    }

    return {
      close,
      handleError,
      handleKeydown,
      handleLoad,
      handleOverlay,
      open,
      positionActions,
      rotate,
      scheduleActionsPosition,
    };
  }

  return {
    createProofViewer,
    isSideways,
    normalizeRotation,
  };
});