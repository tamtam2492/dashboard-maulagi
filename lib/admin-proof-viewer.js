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

    function getImageBounds(sideways) {
      const mobile = window.innerWidth < 720;
      if (sideways) {
        return {
          maxWidth: mobile ? '68vh' : '60vh',
          maxHeight: mobile ? '82vw' : '68vw',
        };
      }
      return {
        maxWidth: '100%',
        maxHeight: mobile ? 'min(46vh, 340px)' : 'min(64vh, 520px)',
      };
    }

  function createProofViewer(refs) {
    const overlay = refs.overlay;
    const stage = refs.stage;
    const actions = refs.actions;
    const image = refs.image;
    const error = refs.error;

    let rotateDeg = 0;
    let positionTimer = 0;

    function positionActions() {
      actions.style.visibility = overlay.classList.contains('show') ? 'visible' : 'hidden';
    }

    function scheduleActionsPosition() {
      window.clearTimeout(positionTimer);
      positionActions();
      positionTimer = window.setTimeout(positionActions, 120);
    }

    function applyRotation() {
      image.style.transform = `rotate(${rotateDeg}deg)`;
        const bounds = getImageBounds(isSideways(rotateDeg));
        image.style.maxWidth = bounds.maxWidth;
        image.style.maxHeight = bounds.maxHeight;
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
      actions.style.visibility = 'hidden';
      error.style.display = 'none';
      rotateDeg = 0;
      image.style.display = '';
      image.style.transform = '';
        const bounds = getImageBounds(false);
        image.style.maxWidth = bounds.maxWidth;
        image.style.maxHeight = bounds.maxHeight;
      image.src = src;
      overlay.classList.add('show');
      scheduleActionsPosition();
    }

    function close() {
      overlay.classList.remove('show');
      window.clearTimeout(positionTimer);
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