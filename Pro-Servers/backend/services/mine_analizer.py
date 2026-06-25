import sys
import os
import json
from collections import deque
from openai import OpenAI

# Configuración de Groq
client = OpenAI(
    api_key="", 
    base_url="https://api.groq.com/openai/v1"
)

def capturar_logs_servidor(ruta_archivo, lineas=100):
    try:
        with open(ruta_archivo, 'r', encoding='utf-8') as archivo:
            ultimas_lineas = deque(archivo, lineas)
            return ''.join(ultimas_lineas)
    except FileNotFoundError:
        return "Error: No se encontró el log del servidor."
    except Exception as e:
        return f"Error leyendo el log: {str(e)}"

# EL BRAZO EJECUTOR (Ahora elimina de verdad)
def ejecutar_castigo_mine(archivo_objetivo):
    ruta_mods = "mods" 
    if not os.path.exists(ruta_mods):
        os.makedirs(ruta_mods)

    ruta_archivo = os.path.join(ruta_mods, archivo_objetivo)
    
    try:
        if os.path.exists(ruta_archivo):
            os.remove(ruta_archivo) # ELIMINACIÓN DIRECTA
            return f"\n[SISTEMA]: El archivo '{archivo_objetivo}' fue eliminado permanentemente."
        else:
            return f"\n[SISTEMA]: '{archivo_objetivo}' no existe en la carpeta mods."
    except Exception as e:
        return f"\n[SISTEMA]: Error al intentar eliminar: {e}"

# EL CEREBRO (Groq + Llama 3.3)
def generar_diagnostico_mine(texto_log):
    # Prompt actualizado para coincidir con lo que imprime el sistema
    prompt = f"""
    Sos 'Mine', el analista experto de servidores de Minecraft.
    Analizá el log. Si falta un mod o hay uno incompatible, ordena eliminarlo.
    
    RESPONDÉ ÚNICAMENTE JSON:
    {{
        "mensaje": "Explicación detallada de por qué causa el error",
        "hay_que_borrar": true/false,
        "archivo_a_borrar": "nombre.jar",
        "paso_a_paso": "Explicación técnica de cómo el usuario debe solucionar esto manualmente",
        "mod_alternativo": "Nombre de mod recomendado para reemplazarlo (o null si no aplica)"
    }}

    LOG:
    {texto_log}
    """
    
    try:
        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )
        return json.loads(response.choices[0].message.content)
    except Exception as e:
        return {"mensaje": f"Error del cerebro: {str(e)}", "hay_que_borrar": False}

if __name__ == "__main__":
    ruta_log = sys.argv[1] if len(sys.argv) > 1 else "server_crash.log"
    
    if not os.path.exists(ruta_log):
        print(f"Error: El archivo {ruta_log} no existe.")
        sys.exit()

    log_texto = capturar_logs_servidor(ruta_log, 100)
    
    # 1. Análisis
    decision = generar_diagnostico_mine(log_texto)
    
    print("\n--- ANÁLISIS DE MINE ---")
    print(f"Explicación: {decision.get('mensaje')}")
    print(f"Recomendación: {decision.get('mod_alternativo')}")
    print(f"Pasos a seguir: {decision.get('paso_a_paso')}")
    
    # 2. Bloque de Seguridad (HUMAN-IN-THE-LOOP)
    if decision.get("hay_que_borrar") and decision.get("archivo_a_borrar"):
        archivo = decision.get("archivo_a_borrar")
        print(f"\n[!] ALERTA: Mine sugiere eliminar el archivo: '{archivo}'")
        confirmacion = input("¿Deseas proceder con la eliminación? (s/n): ").strip().lower()
        
        if confirmacion == 's':
            print(ejecutar_castigo_mine(archivo))
        else:
            print("\n[SISTEMA]: Operación cancelada por el usuario. Archivo seguro.")
    else:
        print("\nMine: No se detectaron acciones destructivas necesarias.")