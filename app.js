// Кыргызское такси — прототип: карта Бишкека, поиск адреса, маршрут и расчёт стоимости.
(() => {
  // Город: центр карты и рамка, за пределы которой адреса не ищем
  const CITY = { center: [42.8746, 74.5698], south: 42.76, west: 74.42, north: 42.97, east: 74.76 };

  // ТАРИФЫ — черновые цифры для демонстрации, заменить на настоящие.
  // Цена = посадка + км × perKm + минуты × perMin, но не меньше min; округляется до 10 сом.
  const TARIFFS = [
    { id: 'econom',  name: 'Эконом',  note: 'до 4 мест', base: 80,  perKm: 17, perMin: 3, min: 100 },
    { id: 'comfort', name: 'Комфорт', note: 'до 4 мест', base: 110, perKm: 22, perMin: 4, min: 150 },
    { id: 'minivan', name: 'Минивэн', note: 'до 7 мест', base: 150, perKm: 28, perMin: 5, min: 220 },
  ];

  // lang=default — названия улиц как на местности (кыргызские/русские), а не в английской транслитерации.
  // Бесплатные открытые сервисы — годятся для прототипа, для запуска нужны свои или платные:
  // поиск адресов Photon (данные OpenStreetMap), маршруты OSRM (без учёта пробок).
  const API = {
    search:  'https://photon.komoot.io/api/',
    reverse: 'https://photon.komoot.io/reverse',
    route:   'https://router.project-osrm.org/route/v1/driving/',
  };

  const $ = id => document.getElementById(id);
  const inputs = { from: $('from'), to: $('to') };
  const suggest = $('suggest'), hint = $('hint'), trip = $('trip'), sheet = $('sheet');
  const desktop = window.matchMedia('(min-width: 860px)');

  const state = { from: null, to: null, active: 'from', route: null, tariff: TARIFFS[0].id };
  const markers = {};
  let routeLine = null;

  // ---------- Карта ----------
  const map = L.map('map', {
    zoomControl: false, minZoom: 11,
    maxBounds: [[CITY.south - .12, CITY.west - .2], [CITY.north + .12, CITY.east + .2]],
  }).setView(CITY.center, 13);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const inCity = (lat, lon) => lat >= CITY.south && lat <= CITY.north && lon >= CITY.west && lon <= CITY.east;
  const setHint = (text, error = false) => { hint.textContent = text; hint.classList.toggle('is-error', error); hint.hidden = !text; };

  // ---------- Адреса ----------
  const labelOf = p => {
    const street = [p.street, p.housenumber].filter(Boolean).join(', ');
    if (p.name && street && p.name !== p.street) return `${p.name}, ${street}`;
    return p.name || street || p.district || 'Точка на карте';
  };

  const reverse = async (lat, lon) => {
    try {
      const res = await fetch(`${API.reverse}?lon=${lon}&lat=${lat}&lang=default`);
      const f = (await res.json()).features[0];
      return f ? labelOf(f.properties) : 'Точка на карте';
    } catch (e) { return 'Точка на карте'; }
  };

  let searchAbort = null, searchTimer = null;
  const search = (which, q) => {
    clearTimeout(searchTimer);
    if (searchAbort) searchAbort.abort();
    if (q.trim().length < 2) { suggest.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      searchAbort = new AbortController();
      const url = `${API.search}?q=${encodeURIComponent(q)}&limit=6&lang=default&lat=${CITY.center[0]}&lon=${CITY.center[1]}` +
        `&bbox=${CITY.west},${CITY.south},${CITY.east},${CITY.north}`;
      try {
        const res = await fetch(url, { signal: searchAbort.signal });
        const items = (await res.json()).features
          .map(f => ({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: labelOf(f.properties), sub: f.properties.district || f.properties.city || '' }))
          .filter(i => inCity(i.lat, i.lon));
        suggest.replaceChildren(...items.map(item => {
          const li = document.createElement('li');
          const b = document.createElement('b'); b.textContent = item.label;
          const s = document.createElement('span'); s.textContent = item.sub;
          li.append(b, s);
          li.addEventListener('click', () => { suggest.hidden = true; setPoint(which, item); });
          return li;
        }));
        suggest.hidden = !items.length;
        if (!items.length) setHint('Ничего не нашли. Попробуйте иначе или нажмите на карту.');
      } catch (e) {
        if (e.name !== 'AbortError') setHint('Поиск адресов сейчас недоступен. Нажмите на карту.', true);
      }
    }, 300);
  };

  // ---------- Точки A и B ----------
  const pinIcon = which => L.divIcon({
    className: '', iconSize: [34, 34], iconAnchor: [17, 34],
    html: `<span class="pin pin--${which}"><i>${which === 'from' ? 'A' : 'B'}</i></span>`,
  });

  const setPoint = (which, point) => {
    state[which] = point;
    inputs[which].value = point.label;
    if (!markers[which]) {
      markers[which] = L.marker([point.lat, point.lon], { icon: pinIcon(which), draggable: true }).addTo(map);
      markers[which].on('dragend', async () => {
        const { lat, lng } = markers[which].getLatLng();
        setPoint(which, { lat, lon: lng, label: await reverse(lat, lng) });
      });
    } else {
      markers[which].setLatLng([point.lat, point.lon]);
    }
    state.active = which === 'from' && !state.to ? 'to' : which;
    update();
  };

  const clearPoint = which => {
    state[which] = null;
    if (markers[which]) { markers[which].remove(); delete markers[which]; }
    state.active = which;
    update();
  };

  const pointFromMap = async (which, lat, lon) => {
    if (!inCity(lat, lon)) { setHint('Пока работаем только в Бишкеке.', true); return; }
    setPoint(which, { lat, lon, label: '…' });
    const label = await reverse(lat, lon);
    if (state[which] && state[which].lat === lat) { state[which].label = label; inputs[which].value = label; }
  };

  map.on('click', e => {
    suggest.hidden = true;
    const which = !state.from ? 'from' : !state.to ? 'to' : state.active;
    pointFromMap(which, e.latlng.lat, e.latlng.lng);
  });

  // ---------- Маршрут и цена ----------
  const priceOf = (t, km, min) => Math.max(t.min, Math.round((t.base + km * t.perKm + min * t.perMin) / 10) * 10);

  const fit = bounds => {
    const h = sheet.getBoundingClientRect();
    map.fitBounds(bounds, desktop.matches
      ? { paddingTopLeft: [h.width + 40, 40], paddingBottomRight: [40, 40] }
      : { paddingTopLeft: [30, 80], paddingBottomRight: [30, h.height + 20] });
  };

  const renderTrip = () => {
    const { km, min } = state.route;
    $('km').textContent = `${km.toFixed(1).replace('.', ',')} км`;
    $('min').textContent = `≈ ${Math.max(1, Math.round(min))} мин в пути`;
    $('tariffs').replaceChildren(...TARIFFS.map(t => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'tariff';
      btn.setAttribute('aria-pressed', String(t.id === state.tariff));
      btn.innerHTML = `<b>${t.name}</b><span>${t.note}</span><strong>${priceOf(t, km, min)} сом</strong>`;
      btn.addEventListener('click', () => { state.tariff = t.id; renderTrip(); });
      return btn;
    }));
    const chosen = TARIFFS.find(t => t.id === state.tariff);
    $('order').textContent = `Заказать · ${priceOf(chosen, km, min)} сом`;
  };

  let routeSeq = 0;
  const update = async () => {
    const seq = ++routeSeq;
    if (routeLine) { routeLine.remove(); routeLine = null; }
    state.route = null;
    trip.hidden = true;
    const { from, to } = state;
    if (!from || !to) {
      setHint(!from && !to ? 'Введите адрес или нажмите на карту' : !to ? 'Теперь укажите, куда ехать' : 'Укажите, откуда вас забрать');
      const one = from || to;
      if (one) map.panTo([one.lat, one.lon]);
      return;
    }
    setHint('Строим маршрут…');
    try {
      const res = await fetch(`${API.route}${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`);
      const data = await res.json();
      if (seq !== routeSeq) return;  // точки уже поменяли
      if (data.code !== 'Ok' || !data.routes.length) throw new Error('no route');
      const r = data.routes[0];
      state.route = { km: r.distance / 1000, min: r.duration / 60 };
      routeLine = L.polyline(r.geometry.coordinates.map(c => [c[1], c[0]]), { color: '#14161c', weight: 5, opacity: .85, lineCap: 'round' }).addTo(map);
      setHint('');
      trip.hidden = false;
      renderTrip();
      fit(routeLine.getBounds());
    } catch (e) {
      if (seq === routeSeq) setHint('Не удалось построить маршрут. Попробуйте ещё раз.', true);
    }
  };

  // ---------- Поля ввода ----------
  Object.entries(inputs).forEach(([which, input]) => {
    input.addEventListener('focus', () => { state.active = which; input.select(); });
    input.addEventListener('input', () => {
      if (!input.value) { suggest.hidden = true; if (state[which]) clearPoint(which); return; }
      search(which, input.value);
    });
  });
  document.addEventListener('click', e => { if (!e.target.closest('.fields, .suggest')) suggest.hidden = true; });

  // Моё местоположение → точка «Откуда»
  $('locate').addEventListener('click', () => {
    if (!navigator.geolocation) { setHint('Браузер не даёт определить местоположение.', true); return; }
    setHint('Определяем, где вы…');
    navigator.geolocation.getCurrentPosition(
      pos => pointFromMap('from', pos.coords.latitude, pos.coords.longitude),
      () => setHint('Не удалось определить местоположение. Укажите адрес вручную.', true),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });

  // ---------- Заказ (демо) ----------
  $('order').addEventListener('click', () => {
    const t = TARIFFS.find(x => x.id === state.tariff);
    const { km, min } = state.route;
    $('doneText').textContent = `${state.from.label} → ${state.to.label}. Тариф «${t.name}», ${priceOf(t, km, min)} сом.`;
    $('orderForm').hidden = true;
    $('done').hidden = false;
  });
  $('again').addEventListener('click', () => {
    $('done').hidden = true;
    $('orderForm').hidden = false;
    inputs.from.value = inputs.to.value = '';
    clearPoint('to'); clearPoint('from');
    map.setView(CITY.center, 13);
  });

  // Ссылка сразу с маршрутом: ?from=42.8762,74.6118&to=42.8427,74.6122
  const params = new URLSearchParams(location.search);
  ['from', 'to'].forEach(which => {
    const [lat, lon] = (params.get(which) || '').split(',').map(Number);
    if (lat && lon) pointFromMap(which, lat, lon);
  });
})();
