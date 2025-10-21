import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  signInWithCustomToken, 
  onAuthStateChanged,
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  query, 
  onSnapshot, 
  doc, 
  serverTimestamp,
  setLogLevel,
  setDoc,
  getDocs,
  writeBatch, // Importar para operaciones por lotes (limpieza y carga)
} from 'firebase/firestore';
import { CheckCircle, Loader, MessageSquare, Heart, Clock, Calendar, Download, AlertTriangle, XCircle, PhoneCall, FileText, TrendingUp, ChevronLeft, ChevronRight, ChevronDown, Lock, Unlock, Trash2 } from 'lucide-react';

// --- Configuración de Firebase y Servicios ---

// Adaptado para leer de process.env (Vercel/Node.js)
const appId = process.env.NEXT_PUBLIC_APP_ID_CUSTOM || 'default-app-id';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const initialAuthToken = process.env.NEXT_PUBLIC_INITIAL_AUTH_TOKEN || null;


// Definición de las 8 metas diarias fijas (se reinician todos los días)
// HORARIOS ACTUALIZADOS SEGÚN LA INFORMACIÓN DEL SUPERVISOR
const FIXED_DAILY_GOALS = [
    { id: 'salida_casa', text: 'Salida de Casa', timeHint: '06:00 - 07:00 AM' },
    { id: 'entrada_trabajo', text: 'Entrada al Trabajo', timeHint: '07:00 - 08:00 AM' },
    { id: 'salida_trabajo', text: 'Salida del Trabajo', timeHint: '17:00 - 18:00 PM' },
    // El grupo es a las 18:00, pero llega más tarde.
    { id: 'entrada_grupo', text: 'Entrada al Grupo/Reunión', timeHint: '18:00 - 20:15 PM' },
    { id: 'salida_grupo', text: 'Salida del Grupo/Reunión', timeHint: 'Después de las 20:15 PM' },
    // AHORA VA PRIMERO LLEGADA A CASA
    { id: 'llegada_casa', text: 'Llegada a Casa', timeHint: 'Aproximadamente 21:00 hs' }, 
    // Y LUEGO VA EL MEDICAMENTO
    { id: 'pastilla_21hs', text: 'Medicamento / Suplemento', timeHint: 'Después de Llegar a Casa' },
    // ULTIMO PUNTO DEL DÍA (El cierre)
    { id: 'llamada_fin_dia', text: 'Llamada al Final del Día', timeHint: 'Último chequeo antes de dormir' },
];

// Definición de los estados de riesgo emocional
const RISK_STATUSES = [
  { value: 'BAJO', label: 'Bajo', color: 'bg-green-500', hover: 'hover:bg-green-600', ring: 'ring-green-400' },
  { value: 'MODERADO', label: 'Moderado', color: 'bg-yellow-500', hover: 'hover:bg-yellow-600', ring: 'ring-yellow-400' },
  { value: 'ALTO', label: 'Alto', color: 'bg-orange-500', hover: 'hover:bg-orange-600', ring: 'ring-orange-400' },
  { value: 'CRITICO', label: 'Crítico', color: 'bg-red-600', hover: 'hover:bg-red-700', ring: 'ring-red-400' },
];

// Configuración de Firebase y Servicios
let app;
let db;
let auth;

try {
  if (Object.keys(firebaseConfig).length > 0) {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    auth = getAuth(app);
    setLogLevel('debug'); // Habilitar logs para depuración de Firestore
  }
} catch (error) {
  console.error("Error al inicializar Firebase:", error);
}

// --- FUNCIÓN DE UTILIDAD DE FECHA ESTÁNDAR ---
/**
 * Devuelve la fecha de hoy en formato YYYY-MM-DD, usando la zona horaria local del navegador/dispositivo.
 */
const getTodayDateString = () => {
    return new Date().toISOString().split('T')[0];
};

// Función de utilidad para obtener la fecha en formato YYYY-MM-DD (usada solo para fechas que ya están en el formato correcto)
const getDateString = (date) => date.toISOString().split('T')[0];

// Función de utilidad para generar la ruta del documento de estado diario (Check-In y Metas Fijas)
const getDailyStatusDocRef = (currentAppId, currentUserId, dateString) => 
  doc(db, `/artifacts/${currentAppId}/public/data/daily_status`, `${currentUserId}-${dateString}`);

// Componente para el cálculo y visualización de la racha
const StreakWidget = ({ currentStreak }) => {
    let message = '¡Empieza tu racha hoy!';
    let color = 'bg-indigo-100 text-indigo-700 border-indigo-300';
    let icon = <Heart className="w-5 h-5 mr-2" />;

    if (currentStreak > 0) {
        message = `¡Racha de ${currentStreak} días con el 100% de cumplimiento!`;
        color = 'bg-green-50 text-green-700 border-green-500 font-bold';
        icon = <TrendingUp className="w-5 h-5 mr-2" />;
    }
    if (currentStreak >= 10) {
        color = 'bg-purple-100 text-purple-700 border-purple-500 font-extrabold shadow-lg';
    }

    return (
        <div className={`p-3 rounded-xl shadow-md flex items-center justify-center text-center text-sm mb-8 border-2 ${color}`}>
            {icon}
            <span>{message}</span>
        </div>
    );
};

// --- Componente de Calendario ---
const ComplianceCalendar = ({ historyData, totalItems, setSelectedDate }) => { // Se añade setSelectedDate
    const [currentMonth, setCurrentMonth] = useState(new Date());
    
    // Mapea el historial a un objeto de acceso rápido por fecha (YYYY-MM-DD)
    const historyMap = useMemo(() => {
        return historyData.reduce((acc, item) => {
            const completed = (item.checkedIn ? 1 : 0) + Object.values(item.fixedGoalsStatus || {}).filter(s => s === true).length;
            // totalItems es 9 (8 fijas + 1 check-in)
            const percentage = totalItems > 0 ? (completed / totalItems) * 100 : 0;
            
            let colorClass = 'bg-gray-400 text-white'; // Default: Fallo Grave
            if (item.dateString <= getTodayDateString()) { // Lógica de comparación con "hoy"
                if (item.hasRelapsed) {
                    colorClass = 'bg-red-600 text-white'; // Recaída (Anula todo)
                } else if (percentage === 100) {
                    colorClass = 'bg-green-500 text-white'; // Éxito total (9/9)
                } else if (completed >= 5) { // CRITERIO OBJETIVO: 5 puntos o más (55.56%)
                    // Color Aceptable: Cambiado a Verde Menta (lime-200) para indicar estructura mantenida.
                    colorClass = 'bg-lime-200 text-gray-800'; 
                } else {
                    colorClass = 'bg-gray-400 text-white'; // Fallo Crítico (menos de 5/9)
                }
            } else {
                colorClass = 'bg-gray-100 text-gray-400 border border-gray-200'; // Día futuro
            }
            
            acc[item.dateString] = {
                color: colorClass,
                percentage: percentage,
                risk: item.emotionalStatus,
                rehab: item.hasCommunicatedWithRehab,
                completed: completed,
                relapsed: item.hasRelapsed // Incluir recaída para el tooltip
            };
            return acc;
        }, {});
    }, [historyData, totalItems]);

    // Lógica del calendario
    const getCalendarDays = () => {
        const year = currentMonth.getFullYear();
        const month = currentMonth.getMonth();
        const firstDayOfMonth = new Date(year, month, 1);
        const lastDayOfMonth = new Date(year, month + 1, 0);
        
        // Días de la semana: 0=Domingo, 1=Lunes. Lo ajustamos para que la semana empiece en Lunes (1)
        const startDayIndex = (firstDayOfMonth.getDay() === 0 ? 6 : firstDayOfMonth.getDay() - 1); 

        const days = [];
        // Días del mes anterior (relleno)
        for (let i = 0; i < startDayIndex; i++) {
            days.push({ key: `prev-${i}`, dayNum: '', currentMonth: false });
        }

        // Días del mes actual
        for (let i = 1; i <= lastDayOfMonth.getDate(); i++) {
            const date = new Date(year, month, i);
            const dateStr = getDateString(date);
            const todayStr = getTodayDateString(); // Usa la fecha de hoy sin offset

            days.push({
                key: dateStr,
                dayNum: i,
                dateStr: dateStr,
                currentMonth: true,
                data: historyMap[dateStr],
                isToday: dateStr === todayStr
            });
        }
        return days;
    };

    const calendarDays = getCalendarDays();
    
    // Cambiar mes
    const changeMonth = (amount) => {
        const newMonth = new Date(currentMonth.setMonth(currentMonth.getMonth() + amount));
        setCurrentMonth(new Date(newMonth)); // Usar new Date para forzar la actualización de estado
    };

    const monthName = currentMonth.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
    
    // Días de la semana en español
    const weekDays = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

    return (
        <div className="bg-white p-4 rounded-lg shadow-xl border mb-8">
            <h3 className="text-xl font-bold text-gray-800 mb-4 flex items-center">
                <Calendar className="w-5 h-5 mr-2 text-indigo-600" />
                Análisis Visual Mensual
            </h3>
            
            {/* Control de Mes */}
            <div className="flex justify-between items-center mb-4">
                <button 
                    onClick={() => changeMonth(-1)} 
                    className="p-1 rounded-full hover:bg-gray-200 transition"
                    aria-label="Mes anterior"
                >
                    <ChevronLeft className="w-5 h-5" />
                </button>
                <span className="text-lg font-semibold capitalize">{monthName}</span>
                <button 
                    onClick={() => changeMonth(1)} 
                    className="p-1 rounded-full hover:bg-gray-200 transition"
                    aria-label="Mes siguiente"
                >
                    <ChevronRight className="w-5 h-5" />
                </button>
            </div>
            
            {/* LEYENDA DEL CALENDARIO */}
            <div className="text-xs text-gray-700 bg-gray-50 p-3 rounded-lg border border-gray-200 mb-4">
                <h4 className="font-bold mb-2 text-sm text-indigo-700">Leyenda de Cumplimiento Objetivo ({totalItems} Puntos Totales)</h4>
                <div className="grid grid-cols-2 gap-2">
                    <div className="flex items-center"><span className="w-3 h-3 rounded-full bg-red-600 mr-2"></span> Recaída (Evento Crítico)</div>
                    <div className="flex items-center"><span className="w-3 h-3 rounded-full bg-green-500 mr-2"></span> 100% (Éxito Máximo)</div>
                    <div className="flex items-center"><span className="w-3 h-3 rounded-full bg-lime-200 mr-2"></span> Aceptable (5 a 8 Puntos)</div> {/* Leyenda actualizada */}
                    <div className="flex items-center"><span className="w-3 h-3 rounded-full bg-gray-400 mr-2"></span> Fallo Crítico (0 a 4 Puntos)</div>
                    <div className="flex items-center"><AlertTriangle className="w-3 h-3 text-yellow-800 mr-2" /> Riesgo Alto/Crítico (Subjetivo)</div>
                    <div className="flex items-center"><PhoneCall className="w-3 h-3 text-indigo-800 mr-2" /> Comunicación Rehab.</div>
                </div>
            </div>
            
            {/* Grid del Calendario */}
            <div className="grid grid-cols-7 gap-1 text-center text-xs">
                {weekDays.map(day => (
                    <div key={day} className="font-bold text-gray-500 py-1">{day}</div>
                ))}
                
                {calendarDays.map(day => {
                    const data = day.data;
                    const tooltipText = data 
                        ? `${day.dateStr} - Cumplimiento: ${data.completed}/${totalItems}. Riesgo: ${data.risk || 'NULO'}. Recaída: ${data.relapsed ? 'SÍ' : 'NO'}.` 
                        : (day.currentMonth ? 'Día sin registro' : '');
                        
                    const isRedBackground = data && data.color.includes('bg-red-600');
                    const iconColorClass = isRedBackground ? 'text-white' : 'text-indigo-700'; // Nuevo color para Rehab


                    return (
                        <div 
                            key={day.key} 
                            className={`relative aspect-square rounded-lg flex flex-col items-center justify-center p-0.5 transition duration-150 
                                ${day.currentMonth ? data ? data.color : 'bg-gray-100' : 'bg-transparent text-gray-400'}
                                ${day.isToday && day.currentMonth ? 'ring-2 ring-indigo-500 ring-offset-2' : ''}
                                ${data ? 'cursor-pointer hover:shadow-lg hover:border-indigo-400' : 'cursor-default'}
                            `}
                            // AHORA LLAMA A setSelectedDate si el día tiene datos
                            onClick={day.dateStr && data ? () => setSelectedDate(day.dateStr) : null}
                            title={tooltipText}
                        >
                            <span className={`text-xs font-semibold ${data?.color.includes('text-white') ? 'text-white' : 'text-gray-900'} z-10`}>
                                {day.dayNum}
                            </span>
                            
                            {/* INDICADORES DE CONTEXTO/RIESGO (Estrategia 3 Esquinas) */}
                            {data && (
                                <>
                                    {/* ICONO 1: ALERTA (Riesgo Alto/Crítico o Recaída) -> ESQUINA SUPERIOR DERECHA */}
                                    {(data.risk === 'ALTO' || data.risk === 'CRITICO' || data.relapsed) && (
                                        <AlertTriangle 
                                            // Si el fondo es rojo (Recaída), forzamos el texto a blanco para que se vea
                                            className={`w-3 h-3 absolute top-0.5 right-0.5 z-20 ${isRedBackground ? 'text-white' : 'text-yellow-800'}`} 
                                            title={data.relapsed ? "RECAÍDA CRÍTICA" : "Riesgo Alto/Crítico"} 
                                        />
                                    )}

                                    {/* ICONO 2: COMUNICACIÓN REHAB -> ESQUINA SUPERIOR IZQUIERDA */}
                                    {data.rehab && (
                                        <PhoneCall 
                                            // Aplicamos la nueva clase de color
                                            className={`w-3 h-3 absolute top-0.5 left-0.5 z-20 ${iconColorClass}`} 
                                            title="Comunicación con Rehabilitación" 
                                        />
                                    )}
                                    
                                    {/* ICONO 3: 100% CUMPLIMIENTO -> ESQUINA INFERIOR DERECHA */}
                                    {data.percentage === 100 && (
                                        <CheckCircle 
                                            className="w-3 h-3 text-white absolute bottom-0.5 right-0.5 z-20" 
                                            title="100% de Cumplimiento" 
                                        />
                                    )}
                                </>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
// --- FIN: Componente de Calendario ---


// Componente principal de la aplicación
const App = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  
  // Estado para la fecha seleccionada
  const [selectedDate, setSelectedDate] = useState(getDateString(new Date()));
  
  // Estados del día seleccionado
  const [hasCheckedIn, setHasCheckedIn] = useState(false);
  const [fixedGoalsStatus, setFixedGoalsStatus] = useState({});
  const [emotionalStatus, setEmotionalStatus] = useState(null);
  const [hasRelapsed, setHasRelapsed] = useState(false);
  const [hasCommunicatedWithRehab, setHasCommunicatedWithRehab] = useState(false);
  const [notes, setNotes] = useState('');
  const [isLocked, setIsLocked] = useState(false); // ESTADO NUEVO: Bloqueo de registro
  
  // ESTADO NUEVO: Historial completo para exportación y análisis de racha
  const [history, setHistory] = useState([]);
  // ESTADO NUEVO: Racha de cumplimiento
  const [currentStreak, setCurrentStreak] = useState(0);

  // Estados para la carga/limpieza de datos de prueba
  const [isSampleLoading, setIsSampleLoading] = useState(false);
  const [sampleError, setSampleError] = useState(null);


  // Función para calcular la racha
  const calculateStreak = useCallback((fetchedHistory) => {
    if (fetchedHistory.length === 0) return 0;
    
    // Obtener solo días completos (no días futuros) y ordenar cronológicamente
    const sortedDays = fetchedHistory
        .filter(item => item.dateString <= getDateString(new Date()))
        .sort((a, b) => a.dateString.localeCompare(b.dateString)); 
    
    if (sortedDays.length === 0) return 0;

    let streak = 0;
    
    // Función para obtener la fecha anterior (YYYY-MM-DD)
    const getPreviousDateString = (date) => {
        const prev = new Date(date);
        prev.setDate(date.getDate() - 1);
        return getDateString(prev);
    }

    // Convertir el historial a un mapa para acceso rápido por fecha
    const historyMap = sortedDays.reduce((acc, item) => {
        acc[item.dateString] = item;
        return acc;
    }, {});

    // Iterar hacia atrás desde la fecha actual para encontrar la racha
    let currentDateStr = getDateString(new Date());

    while (true) {
        const item = historyMap[currentDateStr];

        if (!item) {
            if (currentDateStr === getDateString(new Date())) {
                currentDateStr = getPreviousDateString(new Date(currentDateStr));
                continue;
            } else {
                 break;
            }
        }
        
        // Criterio de Racha: 100% de cumplimiento (9/9)
        const totalCompleted = (item.checkedIn ? 1 : 0) + Object.values(item.fixedGoalsStatus || {}).filter(s => s === true).length;
        if (totalCompleted !== (FIXED_DAILY_GOALS.length + 1)) break;
        
        // Si todo se cumplió, incrementar la racha y pasar al día anterior
        streak++;
        currentDateStr = getPreviousDateString(new Date(currentDateStr));
    }

    return streak;
  }, []);

  // 1. Inicialización y Autenticación de Firebase
  useEffect(() => {
    if (!auth || !db) {
      setError("Firebase no inicializado. Revisa la configuración.");
      setLoading(false);
      return;
    }

    const initializeAuth = async () => {
      try {
        // Usa initialAuthToken si está disponible
        if (initialAuthToken) {
          await signInWithCustomToken(auth, initialAuthToken);
        } else {
          // Si no hay token, usa el inicio de sesión anónimo (según las reglas de Canvas)
          await signInAnonymously(auth);
        }
      } catch (e) {
        console.error("Error en la autenticación inicial:", e);
        try {
           await signInAnonymously(auth);
        } catch(anonError) {
          console.error("Error al intentar firmar anónimamente:", anonError);
          setError("No se pudo iniciar sesión. Verifica el API Key y la configuración.");
          setLoading(false);
        }
      } 
    };

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setUserId(user.uid);
      } else {
        setUserId(null); 
      }
      setIsAuthReady(true);
      setLoading(false);
    });
    
    initializeAuth();

    return () => unsubscribe();
  }, []);

  // 2. Carga del estado diario (Check-In, Metas Fijas, Riesgo, Recaída y Notas) para la fecha seleccionada
  useEffect(() => {
    if (!db || !isAuthReady || !userId || !selectedDate) return;

    const statusRef = getDailyStatusDocRef(appId, userId, selectedDate);

    // Reiniciar estados antes de la suscripción para el nuevo día
    setHasCheckedIn(false);
    setFixedGoalsStatus({});
    setEmotionalStatus(null); 
    setHasRelapsed(false); 
    setHasCommunicatedWithRehab(false);
    setNotes(''); 
    setIsLocked(false); // Reiniciar estado de bloqueo

    const unsubscribe = onSnapshot(statusRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setHasCheckedIn(!!data.checkedIn);
        setFixedGoalsStatus(data.fixedGoalsStatus || {});
        setEmotionalStatus(data.emotionalStatus || null); 
        setHasRelapsed(!!data.hasRelapsed); 
        setHasCommunicatedWithRehab(!!data.hasCommunicatedWithRehab); 
        setNotes(data.notes || ''); 
        setIsLocked(!!data.isLocked); // Cargar estado de bloqueo
      }
      if (error) setError(null);
    }, (e) => {
      console.error("Error al suscribirse a Firestore (Estado Diario):", e);
      setError("Error al cargar el estado diario. Revisa las reglas de seguridad.");
    });

    return () => unsubscribe();
  }, [db, isAuthReady, userId, selectedDate]);
  
  // 3. Carga del Historial Completo y Cálculo de Racha
  const fetchHistory = useCallback(async () => {
    if (!db || !userId) return;
    // La colección está en la ruta pública definida por las reglas
    const collectionRef = collection(db, `/artifacts/${appId}/public/data/daily_status`);
    
    try {
        const querySnapshot = await getDocs(query(collectionRef));
        const fetchedHistory = querySnapshot.docs
            .map(doc => ({
                id: doc.id,
                ...doc.data(),
                dateString: doc.id.replace(`${userId}-`, ''), // Extraer la fecha de la ID
                hasRelapsed: !!doc.data().hasRelapsed,
                hasCommunicatedWithRehab: !!doc.data().hasCommunicatedWithRehab,
                isLocked: !!doc.data().isLocked, // Incluir estado de bloqueo
            }))
            .filter(item => item.userId === userId) // Filtrar solo los datos de este usuario supervisor
            .sort((a, b) => b.dateString.localeCompare(a.dateString)); // Ordenar por fecha descendente
        
        setHistory(fetchedHistory);
        setCurrentStreak(calculateStreak(fetchedHistory));
    } catch (e) {
        console.error("Error fetching history:", e);
    }
  }, [userId, calculateStreak]);
  
  // Ejecutar fetchHistory en cada cambio de estado relevante para mantener la racha actualizada
  useEffect(() => {
    if(isAuthReady && userId) {
        fetchHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthReady, userId, selectedDate, hasCheckedIn, fixedGoalsStatus, emotionalStatus, hasRelapsed, hasCommunicatedWithRehab, notes, isLocked]); 


  // --- FUNCIONES DE TESTING (AHORA ALEATORIAS) ---

  const generateSampleData = useCallback(() => {
    const data = [];
    const today = new Date();
    const totalDays = 30;
    const goalIds = FIXED_DAILY_GOALS.map(g => g.id);
    const totalItems = FIXED_DAILY_GOALS.length + 1; // 9

    for (let i = totalDays - 1; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(today.getDate() - i);
        const dateString = getDateString(date);

        // 1. Random Compliance: Decide cuántos puntos (0 a 9) van a fallar
        const failsCount = Math.floor(Math.random() * (totalItems + 1));
        
        // 2. Distribuir fallos aleatoriamente
        let randomFixedStatus = {};
        let randomCheckedIn = Math.random() < 0.5; // Start with a random check-in status
        let currentFails = (randomCheckedIn ? 0 : 1);
        
        // Distribute the remaining fails (if any)
        FIXED_DAILY_GOALS.forEach(g => {
            // Chance of failing this specific goal based on remaining fails
            const passed = Math.random() > (failsCount - currentFails) / (totalItems - currentFails); 
            randomFixedStatus[g.id] = passed;
            if (!passed) currentFails++;
        });

        // 3. Random Risk Status (Biased towards lower risk)
        let riskIndex = Math.floor(Math.random() * 10); // 0 to 9
        let emotionalStatus = 'BAJO'; 
        if (riskIndex >= 5 && riskIndex <= 7) emotionalStatus = 'MODERADO';
        if (riskIndex === 8) emotionalStatus = 'ALTO';
        if (riskIndex === 9) emotionalStatus = 'CRITICO';

        // 4. Recaída (5% chance if high risk AND low compliance)
        let hasRelapsed = false;
        if (failsCount >= 4 && (emotionalStatus === 'ALTO' || emotionalStatus === 'CRITICO') && Math.random() < 0.10) {
            hasRelapsed = true;
        }

        // 5. Rehab Communication (25% chance, higher if high risk/rehab)
        let hasCommunicatedWithRehab = Math.random() < 0.25 || hasRelapsed;
        
        // 6. Notes
        let notes = hasRelapsed ? 'EVENTO CRÍTICO: Recaída inesperada.' : (currentFails === 0 ? 'Día de estabilidad y cumplimiento perfecto.' : 'Día con cumplimiento parcial y posibles tensiones.');


        let sampleEntry = {
            userId: userId,
            timestamp: serverTimestamp(),
            dateString: dateString,
            checkedIn: randomCheckedIn,
            fixedGoalsStatus: randomFixedStatus,
            emotionalStatus: emotionalStatus,
            hasRelapsed: hasRelapsed,
            hasCommunicatedWithRehab: hasCommunicatedWithRehab,
            notes: notes + ' (Data Random)',
            isLocked: true, 
        };

        data.push(sampleEntry);
    }
    return data;
  }, [userId]);

  const loadSampleData = async () => {
    if (!db || !userId) return;
    setIsSampleLoading(true);
    setSampleError(null);
    
    try {
      const sampleData = generateSampleData();
      const batch = writeBatch(db);
      const collectionRef = collection(db, `/artifacts/${appId}/public/data/daily_status`);

      sampleData.forEach(entry => {
        const docRef = doc(collectionRef, `${userId}-${entry.dateString}`);
        // Eliminar el timestamp temporal que no es compatible con setDoc
        delete entry.timestamp; 
        batch.set(docRef, { ...entry, timestamp: serverTimestamp() }); 
      });

      await batch.commit();
      fetchHistory(); // Recargar el historial para mostrar los datos de prueba
      setIsSampleLoading(false);
    } catch (e) {
      console.error("Error al cargar datos de prueba:", e);
      setSampleError("Error al cargar datos de prueba: " + e.message);
      setIsSampleLoading(false);
    }
  };

  const clearSampleData = async () => {
    if (!db || !userId) return;
    setIsSampleLoading(true);
    setSampleError(null);

    try {
      const collectionRef = collection(db, `/artifacts/${appId}/public/data/daily_status`);
      const querySnapshot = await getDocs(query(collectionRef));
      const batch = writeBatch(db);
      
      querySnapshot.docs
        .filter(doc => doc.id.startsWith(`${userId}-`)) // Filtrar solo los documentos de este usuario
        .forEach(doc => {
          batch.delete(doc.ref);
        });

      await batch.commit();
      fetchHistory(); // Recargar el historial (quedará vacío)
      setIsSampleLoading(false);
    } catch (e) {
      console.error("Error al limpiar datos de prueba:", e);
      setSampleError("Error al limpiar datos de prueba: " + e.message);
      setIsSampleLoading(false);
    }
  };
  // --- FIN: FUNCIONES DE TESTING ---


  // Determina si la fecha seleccionada es futura
  const isFutureDate = selectedDate > getDateString(new Date());


  // Manejadores de Interacción (solo se ejecutan si el día NO está bloqueado NI es futuro)
  const handleDailyCheckIn = async () => {
    if (!db || !userId || !selectedDate || isLocked || isFutureDate) return;
    const statusRef = getDailyStatusDocRef(appId, userId, selectedDate);
    const newStatus = !hasCheckedIn;
    try {
      await setDoc(statusRef, { checkedIn: newStatus, userId: userId, timestamp: serverTimestamp(), dateString: selectedDate }, { merge: true });
    } catch (e) { console.error("Error al registrar el Check-In Diario:", e); setError("No se pudo actualizar el estado del Check-In."); }
  };
  
  const handleToggleFixedGoal = async (goalId) => {
    if (!db || !userId || !selectedDate || isLocked || isFutureDate) return;
    const statusRef = getDailyStatusDocRef(appId, userId, selectedDate);
    const newStatus = !fixedGoalsStatus[goalId];
    try {
      await setDoc(statusRef, { fixedGoalsStatus: { ...fixedGoalsStatus, [goalId]: newStatus }, userId: userId, timestamp: serverTimestamp(), dateString: selectedDate }, { merge: true });
    } catch (e) { console.error("Error al actualizar meta fija:", e); setError("No se pudo actualizar el estado de la meta fija."); }
  };
  
  const handleSetEmotionalStatus = async (statusValue) => {
    if (!db || !userId || !selectedDate || isLocked || isFutureDate) return;
    const statusRef = getDailyStatusDocRef(appId, userId, selectedDate);
    const newStatus = emotionalStatus === statusValue ? null : statusValue;
    try {
      await setDoc(statusRef, { emotionalStatus: newStatus, userId: userId, timestamp: serverTimestamp(), dateString: selectedDate }, { merge: true });
    } catch (e) { console.error("Error al registrar el estado emocional:", e); setError("No se pudo actualizar el estado emocional/riesgo."); }
  };

  const handleToggleRelapse = async () => {
    if (!db || !userId || !selectedDate || isLocked || isFutureDate) return;
    const statusRef = getDailyStatusDocRef(appId, userId, selectedDate);
    const newStatus = !hasRelapsed; 
    try {
      await setDoc(statusRef, { hasRelapsed: newStatus, userId: userId, timestamp: serverTimestamp(), dateString: selectedDate }, { merge: true });
    } catch (e) { console.error("Error al registrar el estado de recaída:", e); setError("No se pudo actualizar el estado de recaída."); }
  };

  const handleToggleRehabCommunication = async () => {
    if (!db || !userId || !selectedDate || isLocked || isFutureDate) return;
    const statusRef = getDailyStatusDocRef(appId, userId, selectedDate);
    const newStatus = !hasCommunicatedWithRehab; 
    try {
        await setDoc(statusRef, { hasCommunicatedWithRehab: newStatus, userId: userId, timestamp: serverTimestamp(), dateString: selectedDate }, { merge: true });
    } catch (e) { console.error("Error al registrar el estado de comunicación con rehab:", e); setError("No se pudo actualizar el estado de comunicación con rehab."); }
  };
  
  const handleUpdateNotes = async (e) => {
    if (!db || !userId || !selectedDate || isLocked || isFutureDate) return;
    const newNotes = e.target.value;
    setNotes(newNotes); 
    const statusRef = getDailyStatusDocRef(appId, userId, selectedDate);
    try {
        await setDoc(statusRef, { notes: newNotes, userId: userId, timestamp: serverTimestamp(), dateString: selectedDate }, { merge: true });
    } catch (e) { console.error("Error al registrar las notas:", e); setError("No se pudieron actualizar las notas."); }
  };

  const handleToggleLock = async () => {
    // El bloqueo NO debe chequear si es un día futuro, porque esa verificación ya se hace en la interfaz
    // Y la deshabilitación del botón si es futuro también se hace en la interfaz, pero el isLocked
    // no es afectado por la fecha futura.
    if (!db || !userId || !selectedDate) return; 

    // Advertencia si está tratando de bloquear un día futuro
    if (selectedDate > getDateString(new Date())) {
        console.error("No se puede bloquear un día futuro.");
        setError("No se puede bloquear un día futuro. Selecciona la fecha actual o pasada.");
        return;
    }

    const statusRef = getDailyStatusDocRef(appId, userId, selectedDate);
    const newLockStatus = !isLocked; 
    try {
      await setDoc(statusRef, { isLocked: newLockStatus, userId: userId, timestamp: serverTimestamp(), dateString: selectedDate }, { merge: true });
    } catch (e) { console.error("Error al alternar el bloqueo:", e); setError("No se pudo actualizar el estado de bloqueo."); }
  };


  // --- CÁLCULO DE PROGRESO Y DATA ---
  const totalFixedGoals = FIXED_DAILY_GOALS.length; // 8
  const completedFixedGoals = Object.values(fixedGoalsStatus).filter(status => status === true).length;
  const totalProgressItems = totalFixedGoals + 1; // 9 (8 Fijas + 1 Check-In)
  const completedProgressItems = completedFixedGoals + (hasCheckedIn ? 1 : 0);
  const progressPercent = totalProgressItems > 0 ? (completedProgressItems / totalProgressItems) * 100 : 0;
  // ---------------------------------

  // Componente para ver el historial y exportar datos
  const HistoryAndExportView = ({ currentUserId, historyData, totalItems, loadSampleData, clearSampleData, isSampleLoading, sampleError, setSelectedDate }) => {
    const [isExporting, setIsExporting] = useState(false);
    const [isHistoryOpen, setIsHistoryOpen] = useState(false); // ESTADO PARA EL DESPLEGABLE

    // Función para convertir a CSV y descargar
    const exportToCSV = () => {
      if (historyData.length === 0) return;

      setIsExporting(true);
      
      const headers = ['Fecha', 'Check_In_Apoyo', 'Emotional_Status', 'Has_Relapsed', 'Rehab_Communication', 'Is_Locked', 'Notes', ...FIXED_DAILY_GOALS.map(g => g.id)];
      
      const csvContent = historyData.map(item => {
        const row = [
            item.dateString, 
            item.checkedIn ? 'SI' : 'NO',
            item.emotionalStatus || 'NULO',
            item.hasRelapsed ? 'SI' : 'NO', 
            item.hasCommunicatedWithRehab ? 'SI' : 'NO',
            item.isLocked ? 'SI' : 'NO', // Añadir estado de bloqueo
            `"${(item.notes || '').replace(/"/g, '""')}"`, // Escapar comillas en las notas
        ];
        
        FIXED_DAILY_GOALS.forEach(goal => {
            const status = item.fixedGoalsStatus?.[goal.id] ? 'SI' : 'NO';
            row.push(status);
        });
        return row.join(',');
      }).join('\n');

      const csv = headers.join(',') + '\n' + csvContent;
      
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.setAttribute("href", url);
      link.setAttribute("download", `RegistroDiario_${currentUserId}_${getDateString(new Date())}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      setTimeout(() => setIsExporting(false), 500);
    };

    // CÁLCULO DE CUMPLIMIENTO POR META (basado en historyData que viene de App)
    const complianceData = FIXED_DAILY_GOALS.map(goal => {
        let completedCount = 0;
        let totalCount = 0;

        historyData.forEach(item => {
            if (item.fixedGoalsStatus && item.fixedGoalsStatus[goal.id] !== undefined) {
                totalCount++;
                if (item.fixedGoalsStatus[goal.id] === true) {
                    completedCount++;
                }
            }
        });

        const compliancePercent = totalCount > 0 ? (completedCount / totalCount) * 100 : 0;
        return {
            id: goal.id,
            text: goal.text,
            percent: compliancePercent.toFixed(1),
            total: totalCount
        };
    });

    return (
      <div className="mt-8 pt-6 border-t border-gray-200">
        {/* ENCABEZADO CLICKEABLE */}
        <button
          className="w-full text-left flex justify-between items-center py-2 text-xl font-semibold text-gray-800 hover:bg-gray-100 rounded-lg p-2 transition duration-150"
          onClick={() => setIsHistoryOpen(!isHistoryOpen)}
          aria-expanded={isHistoryOpen}
          aria-controls="history-content"
        >
            <div className="flex items-center">
                <Download className="w-5 h-5 mr-2 text-green-600" />
                6. Historial y Análisis de Datos
            </div>
            {/* Ícono de Chevron que gira */}
            <ChevronDown className={`w-5 h-5 transition-transform duration-300 ${isHistoryOpen ? 'rotate-180' : 'rotate-0'}`} />
        </button>
        
        {/* CONTENIDO DESPLEGABLE */}
        {isHistoryOpen && (
            <div id="history-content" className="mt-4 animate-in fade-in slide-in-from-top-1">
                
                {/* --- BOTONES DE PRUEBA Y LIMPIEZA (AHORA OCULTOS) --- */}
                <div className="p-4 bg-red-50 border border-red-200 rounded-xl mb-6 hidden">
                    <h3 className="text-lg font-bold text-red-700 mb-3 flex items-center">
                        <AlertTriangle className="w-5 h-5 mr-2" />
                        Herramientas de Testing (Solo para Pruebas)
                    </h3>
                    {sampleError && <p className="text-red-500 text-sm mb-2">{sampleError}</p>}
                    <div className="flex space-x-2">
                        <button
                            onClick={loadSampleData}
                            disabled={isSampleLoading}
                            className="flex-1 p-2 bg-indigo-500 text-white font-bold rounded-lg shadow-md hover:bg-indigo-600 transition duration-150 flex items-center justify-center disabled:opacity-50"
                        >
                            {isSampleLoading ? <Loader className="w-4 h-4 mr-2 animate-spin" /> : 'Cargar 30 Días de Prueba (Random)'}
                        </button>
                        <button
                            onClick={clearSampleData}
                            disabled={isSampleLoading}
                            className="p-2 bg-red-500 text-white font-bold rounded-lg shadow-md hover:bg-red-600 transition duration-150 flex items-center justify-center disabled:opacity-50"
                        >
                            <Trash2 className="w-4 h-4 mr-1" /> Limpiar Datos
                        </button>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">Los datos cargados/limpiados afectan solo tu ID de Supervisor. (Oculto del UI principal).</p>
                </div>
                {/* --- FIN: BOTONES DE PRUEBA --- */}

                {/* Calendario de Cumplimiento */}
                <ComplianceCalendar historyData={historyData} totalItems={totalItems} setSelectedDate={setSelectedDate} />


                {/* Visualización de Tendencias */}
                <div className="bg-indigo-50 p-4 rounded-xl shadow-inner mb-6">
                    <h3 className="text-lg font-bold text-indigo-700 mb-3 border-b pb-2">Tendencia de Cumplimiento (Histórico)</h3>
                    {complianceData.filter(d => d.total > 0).length === 0 ? (
                        <p className='text-sm text-gray-600'>Aún no hay suficientes datos para mostrar la tendencia de cumplimiento.</p>
                    ) : (
                        <ul className="space-y-2">
                            {complianceData.map(data => (
                                <li key={data.id} className="text-sm">
                                    <div className="flex justify-between items-center mb-1">
                                        <span className="font-medium text-gray-700">{data.text}</span>
                                        <span className={`font-bold ${data.percent < 70 ? 'text-red-500' : 'text-green-600'}`}>
                                            {data.percent}%
                                        </span>
                                    </div>
                                    <div className="w-full bg-gray-300 rounded-full h-2.5">
                                        <div 
                                            className={`h-2.5 rounded-full transition-all duration-500 ${data.percent < 70 ? 'bg-orange-500' : 'bg-indigo-500'}`} 
                                            style={{ width: `${data.percent}%` }}
                                        ></div>
                                    </div>
                                    <span className="text-xs text-gray-500 block text-right">({data.total} días registrados)</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>


                <button
                  onClick={exportToCSV}
                  disabled={isExporting || historyData.length === 0}
                  className="w-full p-3 mb-4 bg-green-500 text-white font-bold rounded-lg shadow-md hover:bg-green-600 transition duration-150 flex items-center justify-center disabled:opacity-50"
                >
                  {isExporting ? (
                    <>
                      <Loader className="w-5 h-5 mr-2 animate-spin" />
                      Exportando...
                    </>
                  ) : (
                    <>
                      <Download className="w-5 h-5 mr-2" />
                      Exportar {historyData.length} Días a CSV (Incluye Notas y Bloqueo)
                    </>
                  )}
                </button>

                <div className="max-h-64 overflow-y-auto bg-gray-50 p-3 rounded-lg border">
                    <h3 className="text-sm font-semibold text-gray-700 sticky top-0 bg-gray-50 pb-1">Últimos Registros Detallados:</h3>
                    {historyData.slice(0, 10).map((item) => {
                        const fixedCompleted = Object.values(item.fixedGoalsStatus || {}).filter(s => s).length;
                        const totalCompleted = fixedCompleted + (item.checkedIn ? 1 : 0);
                        const totalItems = FIXED_DAILY_GOALS.length + 1;
                        const statusLabel = RISK_STATUSES.find(s => s.value === item.emotionalStatus)?.label || 'NULO';
                        
                        let indicatorParts = [];
                        
                        // 1. Recaída (Critical) -> Compactado
                        if (item.hasRelapsed) {
                            indicatorParts.push('⚠️ REC.');
                        }
                        
                        // 2. Comunicación Rehab (Action) -> Compactado
                        if (item.hasCommunicatedWithRehab) {
                            indicatorParts.push('📞 REHAB');
                        }
                        
                        // El bloqueo se ha excluido aquí a petición del usuario.
                        let indicator = indicatorParts.join(' ');

                        return (
                            <li key={item.id} className="text-sm flex justify-between items-center p-2 bg-white rounded-md shadow-sm border">
                                <span className="font-semibold text-indigo-700">{item.dateString}</span>
                                <span className={`text-gray-600 text-right ${item.hasRelapsed ? 'text-red-600 font-bold' : ''}`}>
                                    {totalCompleted} / {totalItems} Completados ({statusLabel}) {indicator}
                                </span>
                            </li>
                        );
                    })}
                </div>
            </div>
        )}
      </div>
    );
  };


  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-50">
        <Loader className="w-8 h-8 animate-spin text-indigo-500" />
        <span className="ml-3 text-gray-600">Cargando aplicación...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center bg-red-100 border border-red-400 text-red-700 rounded-lg mx-auto max-w-lg mt-10">
        <p className="font-bold">Error Crítico</p>
        <p>{error}</p>
        <p className="mt-2 text-sm">Por favor, verifica la configuración de Firebase y las reglas de seguridad.</p>
      </div>
    );
  }

  // Se añade la propiedad `disabled` al contenedor principal de los controles
  // si el registro está bloqueado o si es un día futuro.
  const isControlDisabled = isLocked || isFutureDate;


  return (
    <div className="min-h-screen bg-gray-100 p-4 sm:p-8 font-sans">
      <script src="https://cdn.tailwindcss.com"></script>
      <div className="max-w-xl mx-auto bg-white shadow-2xl rounded-xl p-6 sm:p-8">
        
        {/* Encabezado */}
        <header className="mb-6 border-b pb-4">
          <h1 className="text-3xl font-extrabold text-indigo-600 flex items-center">
            <MessageSquare className="w-8 h-8 mr-3" />
            Registro Diario del Supervisor
          </h1>
          <p className="text-gray-500 mt-1">Herramienta objetiva de seguimiento para el encargado.</p>
          <div className="text-xs text-gray-400 mt-2 p-2 bg-indigo-50 rounded-lg break-all">
            Tu ID de Supervisor: <span className="font-mono text-indigo-700">{userId || 'N/A'}</span>
          </div>
        </header>

        {/* Bloqueo de registro (Mensaje de alerta) */}
        {isLocked && (
             <div className="mb-6 p-3 bg-gray-100 border-l-4 border-gray-500 rounded-xl text-gray-700 font-semibold flex items-center shadow-inner">
                <Lock className="w-5 h-5 mr-3 text-gray-600" />
                REGISTRO BLOQUEADO: No se pueden realizar modificaciones para la fecha {selectedDate}.
            </div>
        )}

        {/* Mensaje de Fecha Futura */}
        {isFutureDate && (
             <div className="mb-6 p-3 bg-blue-100 border-l-4 border-blue-500 rounded-xl text-blue-700 font-semibold flex items-center shadow-inner">
                <Calendar className="w-5 h-5 mr-3" />
                DÍA FUTURO: El registro de datos está deshabilitado hasta que llegue esta fecha.
            </div>
        )}

        {/* Selector de Fecha */}
        <div className="mb-8 p-4 bg-indigo-50 rounded-xl shadow-inner flex flex-col sm:flex-row items-start sm:items-center justify-between">
            <div className="flex items-center mb-3 sm:mb-0">
                <Calendar className="w-6 h-6 mr-3 text-indigo-600" />
                <label htmlFor="date-select" className="text-lg font-semibold text-gray-800">Día a Registrar:</label>
            </div>
            <input
                id="date-select"
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="p-2 border border-indigo-300 rounded-lg shadow-sm text-indigo-700 font-mono focus:ring-indigo-500 focus:border-indigo-500 w-full sm:w-auto"
            />
        </div>

        {/* Barra de Progreso */}
        <div className="mb-4">
          <h2 className="text-xl font-semibold text-gray-800 mb-2">Progreso del Día ({selectedDate})</h2>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div 
              className="bg-indigo-500 h-3 rounded-full transition-all duration-500" 
              style={{ width: `${progressPercent}%` }}
            ></div>
          </div>
          <p className="text-sm text-gray-600 mt-2">{completedProgressItems} de {totalProgressItems} pasos verificados ({progressPercent.toFixed(0)}%)</p>
        </div>
        
        {/* Módulo de Celebración de Rachas */}
        <StreakWidget currentStreak={currentStreak} />

        {/* --- CONTROLES DE REGISTRO DIARIO (Secciones 1, 2, 3, 4) --- */}
        <div className={isControlDisabled ? 'opacity-60 pointer-events-none' : ''}>

            {/* Sección de Check-In Diario */}
            <div className="mb-8 p-4 bg-yellow-50 border-l-4 border-yellow-500 rounded-xl shadow-md flex justify-between items-center">
                <div className="flex items-center">
                    <Heart className={`w-8 h-8 mr-3 ${hasCheckedIn ? 'text-green-600' : 'text-yellow-600'}`} />
                    <div>
                        <h2 className="text-xl font-semibold text-gray-800">1. Contacto con Apoyo</h2>
                        <p className="text-sm text-gray-600">Verificado: ¿Se realizó el contacto con el grupo de apoyo?</p>
                    </div>
                </div>
                <button
                    onClick={handleDailyCheckIn}
                    disabled={isLocked || isFutureDate} 
                    className={`p-3 rounded-lg shadow-md transition duration-150 flex items-center justify-center font-bold min-w-[120px] disabled:opacity-50 disabled:cursor-not-allowed ${
                        hasCheckedIn
                            ? 'bg-green-500 text-white hover:bg-green-600'
                            : 'bg-yellow-600 text-white hover:bg-yellow-700'
                    }`}
                    aria-label={hasCheckedIn ? "Desmarcar Contacto" : "Marcar Contacto"}
                >
                    {hasCheckedIn ? 'VERIFICADO' : 'PENDIENTE'}
                </button>
            </div>
            
            {/* Sección de Metas de Rutina Diaria Fijas */}
            <section className="mb-8">
                <h2 className="text-xl font-semibold text-gray-800 mb-4 flex items-center">
                    <Clock className="w-6 h-6 mr-2 text-indigo-500" />
                    2. Rutina Diaria (8 Puntos de Control)
                </h2>
                <ul className="space-y-3">
                {FIXED_DAILY_GOALS.map((goal) => {
                    const isCompleted = fixedGoalsStatus[goal.id];
                    return (
                        <li 
                        key={goal.id} 
                        className={`flex items-center p-4 rounded-xl shadow-sm transition duration-200 ${
                            isCompleted
                            ? 'bg-green-50 border-l-4 border-green-500' 
                            : 'bg-white border-l-4 border-gray-300 hover:shadow-md'
                        }`}
                        >
                        
                        {/* Botón de Completado */}
                        <button
                            onClick={() => handleToggleFixedGoal(goal.id)}
                            disabled={isLocked || isFutureDate} 
                            className={`p-1.5 rounded-full mr-4 transition duration-150 disabled:opacity-50 disabled:cursor-not-allowed ${
                            isCompleted
                                ? 'text-green-600 bg-white shadow-inner'
                                : 'text-gray-400 hover:text-indigo-600 hover:bg-indigo-100'
                            }`}
                            aria-label={isCompleted ? `Desmarcar ${goal.text}` : `Marcar ${goal.text}`}
                        >
                            <CheckCircle className="w-6 h-6" fill={isCompleted ? 'currentColor' : 'none'} strokeWidth={1.5} />
                        </button>

                        {/* Texto de la Meta */}
                        <span className={`flex-grow text-gray-700 ${isCompleted ? 'line-through text-gray-500 italic' : 'font-medium'}`}>
                            {goal.text}
                            <span className="text-xs ml-2 px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full">{goal.timeHint}</span>
                        </span>
                        </li>
                    );
                })}
                </ul>
            </section>
            
            {/* Sección de Estado Emocional / Riesgo y Supervisión */}
            <section className="mb-8 p-4 bg-red-50 border-l-4 border-red-500 rounded-xl shadow-md">
                <h2 className="text-xl font-semibold text-gray-800 mb-3 flex items-center">
                    <AlertTriangle className="w-6 h-6 mr-2 text-red-600" />
                    3. Estado Emocional / Riesgo y Supervisión
                </h2>
                <div className="flex flex-wrap gap-2 mb-4 justify-center sm:justify-between">
                    {RISK_STATUSES.map(status => (
                        <button
                            key={status.value}
                            onClick={() => handleSetEmotionalStatus(status.value)}
                            disabled={isLocked || isFutureDate} 
                            className={`py-2 px-4 text-white font-bold rounded-lg shadow-md transition duration-150 transform hover:scale-[1.02] text-sm w-full sm:w-[calc(50%-4px)] md:w-[calc(25%-6px)] disabled:opacity-50 disabled:cursor-not-allowed
                                ${status.color} ${status.hover}
                                ${emotionalStatus === status.value ? `ring-4 ${status.ring} ring-opacity-70 flex items-center justify-center` : ''}
                            `}
                            aria-label={`Clasificar riesgo como ${status.label}`}
                        >
                            {/* Icono de Check si está seleccionado para feedback visual claro */}
                            {emotionalStatus === status.value && <CheckCircle className="w-4 h-4 mr-1.5" />}
                            {status.label}
                        </button>
                    ))}
                </div>
                
                {/* Botón de Comunicación con Rehabilitación */}
                <button
                    onClick={handleToggleRehabCommunication}
                    disabled={isLocked || isFutureDate} 
                    className={`w-full p-3 mb-3 font-bold rounded-lg shadow-xl transition duration-150 transform hover:scale-[1.01] flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed ${
                        hasCommunicatedWithRehab 
                            ? 'bg-indigo-700 text-white ring-4 ring-indigo-400 ring-opacity-70' 
                            : 'bg-indigo-500 text-white hover:bg-indigo-600'
                    }`}
                >
                    {hasCommunicatedWithRehab ? (
                        <>
                            <PhoneCall className="w-6 h-6 mr-3" />
                            COMUNICACIÓN CON REHABILITACIÓN MARCADADA
                        </>
                    ) : (
                        <>
                            <PhoneCall className="w-6 h-6 mr-3" />
                            MARCAR COMUNICACIÓN CON REHABILITACIÓN
                        </>
                    )}
                </button>


                {/* Botón de Recaída Consumada */}
                <button
                    onClick={handleToggleRelapse}
                    disabled={isLocked || isFutureDate} 
                    className={`w-full p-3 font-bold rounded-lg shadow-xl transition duration-150 transform hover:scale-[1.01] flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed ${
                        hasRelapsed 
                            ? 'bg-red-800 text-white ring-4 ring-red-400 ring-opacity-70' 
                            : 'bg-red-500 text-white hover:bg-red-600'
                    }`}
                >
                    {hasRelapsed ? (
                        <>
                            <XCircle className="w-6 h-6 mr-3" />
                            RECAÍDA MARCADADA (Click para DESMARCAR)
                        </>
                    ) : (
                        <>
                            <AlertTriangle className="w-6 h-6 mr-3" />
                            MARCAR RECAÍDA CONSUMADA
                        </>
                    )}
                </button>
                
                <p className="mt-3 text-sm text-gray-600 text-center">
                    Riesgo Subjetivo: <span className="font-bold text-red-700">{emotionalStatus || 'Sin clasificar'}</span>
                </p>
            </section>

            {/* Sección de Notas/Observaciones (AHORA ES LA SECCIÓN 4) */}
            <section className="mb-8 p-4 bg-gray-50 border-l-4 border-gray-400 rounded-xl shadow-md">
                <h2 className="text-xl font-semibold text-gray-800 mb-3 flex items-center">
                    <FileText className="w-6 h-6 mr-2 text-gray-600" />
                    4. Notas y Observaciones
                </h2>
                <textarea
                    value={notes}
                    onChange={handleUpdateNotes}
                    disabled={isLocked || isFutureDate} 
                    placeholder="Escribe aquí cualquier observación, humor, incidente o contexto importante para el día seleccionado..."
                    rows="4"
                    className="w-full p-3 border border-gray-300 rounded-lg shadow-sm focus:ring-indigo-500 focus:border-indigo-500 resize-none text-sm disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed"
                />
                <p className="mt-2 text-xs text-gray-500 text-right">Las notas se guardan automáticamente. (Deshabilitado si el registro está bloqueado o es un día futuro).</p>
            </section>

        </div>
        {/* --- FIN: CONTROLES DE REGISTRO DIARIO --- */}

        {/* Bloqueo del Registro (Data Lock) (AHORA ES LA SECCIÓN 5) */}
        <section className="mb-8 p-4 bg-gray-200 rounded-xl shadow-md border border-gray-300">
            <h2 className="text-xl font-semibold text-gray-800 mb-3 flex items-center">
                <Lock className="w-6 h-6 mr-2 text-gray-700" />
                5. Bloqueo de Integridad (Finalizar Día)
            </h2>
            <button
                onClick={handleToggleLock}
                disabled={selectedDate > getDateString(new Date())} // No puedes bloquear un día futuro
                className={`w-full p-3 font-bold rounded-lg shadow-xl transition duration-150 transform hover:scale-[1.01] flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed ${
                    isLocked 
                        ? 'bg-gray-700 text-white hover:bg-gray-800' 
                        : 'bg-indigo-600 text-white hover:bg-indigo-700'
                }`}
            >
                {isLocked ? (
                    <>
                        <Unlock className="w-6 h-6 mr-3" />
                        DESBLOQUEAR REGISTRO ({selectedDate})
                    </>
                ) : (
                    <>
                        <Lock className="w-6 h-6 mr-3" />
                        BLOQUEAR DÍA (Finalizar Registro)
                    </>
                )}
            </button>
            <p className="mt-2 text-xs text-gray-600 text-center">
                El bloqueo previene modificaciones accidentales, asegurando la integridad de los datos para el análisis.
            </p>
        </section>


        {/* Historial y Exportación de Datos (Ahora SECCIÓN 6) */}
        <HistoryAndExportView 
          currentUserId={userId} 
          historyData={history} 
          totalItems={totalProgressItems} 
          loadSampleData={loadSampleData} 
          clearSampleData={clearSampleData} 
          isSampleLoading={isSampleLoading}
          sampleError={sampleError}
          setSelectedDate={setSelectedDate}
        />
        
        {/* Nota de la App */}
        <footer className="mt-8 pt-4 border-t text-sm text-gray-500 text-center">
            <p>La objetividad en el registro es fundamental para el análisis de patrones y el éxito del proceso.</p>
        </footer>
      </div>
    </div>
  );
};

export default App;
